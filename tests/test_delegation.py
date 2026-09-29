"""Delegation tests. Same harness shape as test_identity_admin.py: an in-memory rdflib
Dataset behind an injected ``query_fn`` that returns SPARQL-JSON, so the
decision logic runs without Fuseki."""

import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from pyshacl import validate
from rdflib import Dataset, Graph, URIRef

from holonbridge import delegation as dg

HOLONS = "urn:t:holons"
KURT = "urn:t:person:kurt"
PA = "urn:t:person:pa"
OTHER = "urn:t:person:other"
PERSONA = "urn:t:persona:phoebe"
KURT_HOLONS = "urn:t:persona:phoebe:user:kurt:holons"
KURT_SCENE = "urn:t:persona:phoebe:user:kurt:scene"
OTHER_HOLONS = "urn:t:persona:phoebe:user:other:holons"

T0 = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)
SHAPES = Path(__file__).parent.parent / "holonbridge" / "shapes" / "delegation.ttl"


def run(coro):
    return asyncio.run(coro)


class Store:
    def __init__(self):
        self.ds = Dataset()
        self.g = self.ds.graph(URIRef(HOLONS))
        self.g.parse(
            data=f"""@prefix holon: <https://w3id.org/holon/> .
<{KURT}> a holon:Person . <{PA}> a holon:Person . <{OTHER}> a holon:Person .
<{PERSONA}> a holon:Persona .""",
            format="turtle",
        )

    def query_fn(self, q):
        res = self.ds.query(q)
        if res.type == "ASK":
            return {"boolean": bool(res.askAnswer)}
        return json.loads(res.serialize(format="json"))

    def update(self, q):
        self.ds.update(q)

    def add(self, ttl):
        self.g.parse(data=ttl, format="turtle")


def make(store, *, iri="urn:t:delegation:d1", delegate=PA, perms=("read", "write"),
         graphs=(KURT_HOLONS,), start=T0, days=7, delegator=KURT):
    ttl = dg.build_delegation(
        delegation_iri=iri, delegator=delegator, delegate=delegate, persona=PERSONA,
        graphs=graphs, permissions=perms, valid_from=start,
        valid_until=start + timedelta(days=days),
    )
    store.add(ttl)
    return iri


def find(store, **kw):
    kw.setdefault("now", T0 + timedelta(hours=1))
    kw.setdefault("permission", "write")
    kw.setdefault("delegate", PA)
    return run(dg.find_delegation(store.query_fn, HOLONS, **kw))


# --- lookup ---------------------------------------------------------------

def test_active_delegation_matches_covered_graph():
    s = Store(); make(s)
    m = find(s, target=KURT_HOLONS)
    assert len(m) == 1 and m[0].delegator == KURT and m[0].persona == PERSONA


def test_uncovered_graph_does_not_match():
    s = Store(); make(s)
    assert find(s, target=OTHER_HOLONS) == []
    assert find(s, target=KURT_SCENE) == []          # not listed on this delegation


def test_permission_is_respected():
    s = Store(); make(s, perms=("read",))
    assert find(s, target=KURT_HOLONS, permission="write") == []
    assert len(find(s, target=KURT_HOLONS, permission="read")) == 1


def test_replace_is_not_a_permission():
    s = Store(); make(s)
    with pytest.raises(dg.DelegationError):
        find(s, target=KURT_HOLONS, permission="replace")


def test_wrong_delegate_does_not_match():
    s = Store(); make(s)
    assert find(s, target=KURT_HOLONS, delegate=OTHER) == []


def test_expired_and_not_yet_valid():
    s = Store(); make(s, days=1)
    assert find(s, target=KURT_HOLONS, now=T0 + timedelta(days=2)) == []
    assert find(s, target=KURT_HOLONS, now=T0 - timedelta(hours=1)) == []
    # boundary: validUntil is exclusive
    assert find(s, target=KURT_HOLONS, now=T0 + timedelta(days=1)) == []


def test_revoked_delegation_stops_working_and_revoke_is_idempotent():
    s = Store(); iri = make(s)
    s.update(dg.revoke_update(HOLONS, iri, T0))
    s.update(dg.revoke_update(HOLONS, iri, T0 + timedelta(minutes=5)))
    assert find(s, target=KURT_HOLONS) == []
    n = len(list(s.g.objects(URIRef(iri), URIRef(dg.HOLON + "revokedAt"))))
    assert n == 1


def test_deactivated_delegator_kills_delegation_without_retraction():
    s = Store(); make(s)
    s.add(f'@prefix holon: <https://w3id.org/holon/> . <{KURT}> holon:status "inactive" .')
    assert find(s, target=KURT_HOLONS) == []


def test_narrowing_by_delegator_for_reads():
    s = Store(); make(s)
    assert len(find(s, permission="read", delegator=KURT)) == 1
    assert find(s, permission="read", delegator=OTHER) == []


def test_revoke_all_covers_both_directions():
    s = Store()
    make(s, iri="urn:t:delegation:a")                                   # KURT -> PA
    make(s, iri="urn:t:delegation:b", delegator=PA, delegate=OTHER,     # PA -> OTHER
         graphs=("urn:t:persona:phoebe:user:pa:holons",))
    s.update(dg.revoke_all_update(HOLONS, PA, T0))
    rows = run(dg.list_delegations(s.query_fn, HOLONS, now=T0 + timedelta(hours=1)))
    assert {r["status"] for r in rows} == {"revoked"} and len(rows) == 2


def test_list_reports_derived_status_and_direction():
    s = Store()
    make(s, iri="urn:t:delegation:live")
    make(s, iri="urn:t:delegation:old", start=T0 - timedelta(days=30), days=7)
    rows = run(dg.list_delegations(s.query_fn, HOLONS, person=KURT, direction="given",
                                   now=T0 + timedelta(hours=1)))
    by = {r["delegation"]: r["status"] for r in rows}
    assert by == {"urn:t:delegation:live": "active", "urn:t:delegation:old": "expired"}
    assert run(dg.list_delegations(s.query_fn, HOLONS, person=KURT, direction="received")) == []


# --- request validation ---------------------------------------------------

def _v(**kw):
    base = dict(delegator=KURT, delegate=PA, permissions=["read"], roles=["holons"],
                lifetime=timedelta(days=1))
    base.update(kw)
    dg.validate_request(**base)


def test_validation_rejects_bad_requests():
    _v()  # baseline passes
    for bad in (
        dict(delegate=KURT),                      # self
        dict(permissions=[]),                     # none
        dict(permissions=["replace"]),            # never
        dict(permissions=["admin"]),
        dict(roles=["events"]),                   # audit ledger
        dict(roles=[]),
        dict(lifetime=timedelta(0)),
        dict(lifetime=timedelta(days=365)),
    ):
        with pytest.raises(dg.DelegationError):
            _v(**bad)


# --- shapes ---------------------------------------------------------------

def conforms(ttl):
    data = Graph().parse(data=ttl, format="turtle")
    data.parse(data=f"""@prefix holon: <https://w3id.org/holon/> .
<{KURT}> a holon:Person . <{PA}> a holon:Person . <{OTHER}> a holon:Person .
<{PERSONA}> a holon:Persona .""", format="turtle")
    ok, _, text = validate(data, shacl_graph=str(SHAPES), advanced=True, inference="none")
    return ok, text


def build(**kw):
    args = dict(delegation_iri="urn:t:delegation:s", delegator=KURT, delegate=PA,
                persona=PERSONA, graphs=[KURT_HOLONS], permissions=["read", "write"],
                valid_from=T0, valid_until=T0 + timedelta(days=7))
    args.update(kw)
    return dg.build_delegation(**args)


def test_shape_accepts_a_well_formed_delegation():
    ok, text = conforms(build())
    assert ok, text


def test_shape_accepts_holons_and_scene():
    ok, text = conforms(build(graphs=[KURT_HOLONS, KURT_SCENE]))
    assert ok, text


@pytest.mark.parametrize("kw, why", [
    (dict(graphs=[OTHER_HOLONS]), "someone else's graph"),
    (dict(graphs=["urn:t:holons"]), "ground truth"),
    (dict(graphs=["urn:t:persona:phoebe:user:kurt:events"]), "events ledger"),
    (dict(delegate=KURT), "self-delegation"),
    (dict(valid_until=T0 - timedelta(days=1)), "ends before it begins"),
])
def test_shape_rejects(kw, why):
    ok, _ = conforms(build(**kw))
    assert not ok, why


def test_shape_rejects_replace_permission():
    ttl = build().replace('"write"', '"replace"')
    ok, _ = conforms(ttl)
    assert not ok
