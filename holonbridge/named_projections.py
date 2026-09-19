"""Named-projection registry loading.

A Named Projection pairs a registered named query (the semantic call --
loaded and bound via ``holonbridge.named_queries``) with a stored prompt
template (the deferred transform). It is the "named presentation" concept:
analogous to a Named Query, but its raw query result is not itself the
deliverable -- the prompt's rendering of that result is.

**Single vocabulary, unlike named queries.** ``named_queries.py`` reconciles
two schemes (``hb:``/``hquery:``) because both predate this module and both
are still hand-authored in the wild. Named Projection has no such history:
it is registered exclusively through ``register_named_projection``, so
there is exactly one shape (``hb:NamedProjection``) and no vocabulary
dispatch to do.

**No parameter sub-registry of its own.** A projection's parameter contract
*is* its wrapped named query's parameter contract -- ``run_named_projection``
binds against the wrapped query's own declared ``Parameter`` list via
``named_queries.apply_query_params``, so this module carries no parallel
``Parameter``-loading logic to keep in sync with that one.

**Execution mode.** ``hb:executionMode`` is carried through unchanged from
the registry (only ``"deferred"`` is accepted at registration time for
now -- see ``routes/named_projections.py``), left as an explicit field
rather than hardcoded so a later, server-executed mode has a schema slot
already reserved for it.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Mapping

from .conn import Conn
from .fuseki import FusekiClient, FusekiError
from .rdfutil import collect, pick

log = logging.getLogger("holonbridge.named_projections")

HB_NAMESPACE = "https://w3id.org/holonbridge/"

#: Local name that marks a registered projection. Same loose-suffix-match
#: strategy as named_queries.py's QUERY_CLASS_SUFFIX, for the same reason:
#: tolerant of namespace variation, survives a future second scheme.
PROJECTION_CLASS_SUFFIX = "NamedProjection"

_PROJECTION_FIELDS: dict[str, tuple[str, ...]] = {
    "id": ("id", "identifier"),
    "named_query": ("namedQuery", "query"),
    "prompt_text": ("promptText", "prompt"),
    "output_format": ("outputFormat", "format"),
    "execution_mode": ("executionMode", "mode"),
    "label": ("label", "title"),
    "description": ("description", "comment"),
}

#: The single interpolation placeholder a prompt template may use, filled
#: in at run time with the wrapped query's rendered result (Turtle for a
#: CONSTRUCT/DESCRIBE, JSON for a SELECT/ASK). Deliberately one fixed name
#: rather than a declarable variable -- see the module docstring in
#: routes/named_projections.py for why this was simplified from the
#: original design scope's "whichever placeholder the prompt declares."
RESULT_PLACEHOLDER = "result"
_RESULT_RE = re.compile(r"\{\{\s*" + RESULT_PLACEHOLDER + r"\s*\}\}")


@dataclass
class NamedProjection:
    """A projection as loaded from the registry."""

    id: str
    iri: str
    named_query: str
    prompt_text: str
    execution_mode: str = "deferred"
    output_format: str = ""
    label: str = ""
    description: str = ""

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "iri": self.iri,
            "label": self.label or self.id,
            "description": self.description,
            "namedQuery": self.named_query,
            "outputFormat": self.output_format,
            "executionMode": self.execution_mode,
        }

    def detail(self) -> dict[str, Any]:
        return {**self.summary(), "promptText": self.prompt_text}


@dataclass
class ProjectionLoadResult:
    projections: list[NamedProjection]
    warnings: list[str] = field(default_factory=list)

    def by_id(self, projection_id: str) -> NamedProjection | None:
        for projection in self.projections:
            if projection.id == projection_id:
                return projection
        return None

    def by_id_or_iri(self, value: str) -> NamedProjection | None:
        found = self.by_id(value)
        if found is not None:
            return found
        for projection in self.projections:
            if projection.iri == value:
                return projection
        return None


def _projections_query(graph: str) -> str:
    return f"""SELECT ?q ?type ?p ?o
WHERE {{
  GRAPH <{graph}> {{
    ?q a ?type .
    FILTER( STRENDS(STR(?type), "{PROJECTION_CLASS_SUFFIX}") )
    ?q ?p ?o .
  }}
}}"""


async def load_named_projections(
    client: FusekiClient, conn: Conn, *, graph: str | None = None
) -> ProjectionLoadResult:
    """Load every registered projection from ``urn:{dataset}:named-projections``.

    Degrades rather than failing, same as ``load_named_queries``: an
    unreachable registry yields an empty result with a warning rather than
    raising.
    """
    registry = graph or conn.graph("named-projections")

    try:
        rows = (await client.select(conn, _projections_query(registry)))["results"][
            "bindings"
        ]
    except (FusekiError, KeyError) as exc:
        message = f"named-projection load from <{registry}> failed: {exc}"
        log.warning(message)
        return ProjectionLoadResult(projections=[], warnings=[message])

    grouped = collect(rows, "q")
    warnings: list[str] = []
    projections: list[NamedProjection] = []
    seen: dict[str, str] = {}  # id -> iri, for duplicate detection

    for iri, props in sorted(grouped.items()):
        prompt_text = pick(props, _PROJECTION_FIELDS["prompt_text"])
        named_query = pick(props, _PROJECTION_FIELDS["named_query"])
        if not prompt_text or not named_query:
            warnings.append(
                f"<{iri}> is missing promptText or namedQuery; skipped"
            )
            continue

        projection_id = pick(props, _PROJECTION_FIELDS["id"]) or iri.rsplit("/", 1)[-1]

        if projection_id in seen:
            warnings.append(
                f"id {projection_id!r} is registered twice: keeping "
                f"<{seen[projection_id]}>, shadowing <{iri}>"
            )
            continue

        seen[projection_id] = iri
        projections.append(
            NamedProjection(
                id=projection_id,
                iri=iri,
                named_query=named_query,
                prompt_text=prompt_text,
                execution_mode=pick(props, _PROJECTION_FIELDS["execution_mode"]) or "deferred",
                output_format=pick(props, _PROJECTION_FIELDS["output_format"]) or "",
                label=pick(props, _PROJECTION_FIELDS["label"]) or projection_id,
                description=pick(props, _PROJECTION_FIELDS["description"]) or "",
            )
        )

    projections.sort(key=lambda p: p.id)
    return ProjectionLoadResult(projections=projections, warnings=warnings)


def render_prompt(prompt_text: str, result_text: str) -> str:
    """Interpolate a wrapped query's rendered result into a prompt template.

    Substitutes every ``{{result}}`` occurrence with ``result_text`` via a
    replacement *function* (not a plain string) specifically so a Turtle or
    JSON result containing backslashes is never misread as a regex
    backreference by ``re.sub``. If the template declares no ``{{result}}``
    placeholder at all, the result is appended rather than silently
    dropped -- a prompt is expected to consume the result somehow, and a
    template with a typo'd placeholder should not quietly lose it.
    """
    if _RESULT_RE.search(prompt_text):
        return _RESULT_RE.sub(lambda _match: result_text, prompt_text)
    return f"{prompt_text}\n\n{result_text}"


def render_template(template: str, slots: Mapping[str, str]) -> str:
    """Interpolate one or more named ``{{slot}}`` placeholders into a template.

    Generalises this module's own ``render_prompt`` -- a single, fixed
    ``{{result}}`` slot -- to an arbitrary set of named slots. Added for
    pipeline ``llm`` stages (``pipeline.py``), which need ``{{input}}`` and
    ``{{context}}`` resolved at once rather than one fixed placeholder.
    ``render_prompt`` itself is untouched: it keeps its own regex and
    behaviour exactly as before, rather than being rewritten in terms of
    this function, so nothing that already depends on it can be affected
    by this addition.

    Each substitution still goes through a replacement *function*, not a
    plain string, for the same reason ``render_prompt`` does: a Turtle or
    JSON value containing backslashes must never be misread as a regex
    backreference by ``re.sub``.

    A slot whose placeholder does not appear anywhere in the template is
    simply unused -- no error. If none of ``slots``' placeholders were
    found anywhere in the template, the first slot's value is appended
    rather than silently dropped, preserving the same "a template that
    forgot its placeholder still gets the value" behaviour ``render_prompt``
    established.
    """
    rendered = template
    matched_any = False
    for name, value in slots.items():
        pattern = re.compile(r"\{\{\s*" + re.escape(name) + r"\s*\}\}")
        if pattern.search(rendered):
            matched_any = True
            rendered = pattern.sub(lambda _match, _value=value: _value, rendered)
    if not matched_any and slots:
        first_value = next(iter(slots.values()))
        rendered = f"{rendered}\n\n{first_value}"
    return rendered
