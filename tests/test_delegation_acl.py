"""Delegation as seen through the real ACL functions.

test_delegation.py covers delegation.py in isolation. This file covers the
integration that actually matters for safety: that check_write and
authorize_query honour an active delegation, and -- just as important --
that everything else still fails closed. In particular check_replace must
never be satisfied by a delegation, and one uncovered graph in a
multi-graph query must still deny the whole query.

Same harness shape as test_identity_admin.py: a real in-memory rdflib
Dataset behind an injected query_fn.
"""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from rdflib import Dataset, URIRef

from holonbridge import delegation as dg
from holonbridge.acl import authorize_query, check_replace, check_write

HOLON = "https://w3id.org/holon/"
HOLONS = "urn:example:holons"
KURT = "urn:example:person:kurt"
PA = "urn:example:person:pa"
OTHER = "urn:example:person:other"
PERSONA = "urn:example:persona:phoebe"

KURT_HOLONS = "urn:example:persona:phoebe:user:kurt:holons"
KURT_SCENE = "urn:example:persona:phoebe:user:kurt:scene"
OTHER_HOLONS = "urn:example:persona:phoebe:user:other:holons"
GROUND_TRUTH = "urn:example:holons"

FIXTURE = f"""
@prefix holon: <{HOLON}> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<urn:example:role:admin> a holon:Role .
<{KURT}> a holon:Person ; rdfs:label "Kurt" .
<{PA}> a holon:Person ; rdfs:label "PA" .
<{OTHER}> a holon:Person ; rdfs:label "Other" .
<{PERSONA}> a holon:Persona .
"""


def _query_fn(ds):
    async def query_fn(sparql: str) -> dict:
        result = ds.query(sparql)
        if result.type == "ASK":
            return {"boolean": bool(result.askAnswer)}
        bindings = []
        for row in result:
            binding = {}
            for var in result.vars:
                val = row[var]
                if val is None:
                    continue
                binding[str(var)] = {
                    "type": "uri" if str(val).startswith(("http", "urn")) else "literal",
                    "value": str(val),
                }
            bindings.append(binding)
        return {"results": {"bindings": bindings}}

    return query_fn


def persona_of_graph(graph_iri: str):
    prefix = "urn:example:persona:"
    if not graph_iri.startswith(prefix):
        return None
    return prefix + graph_iri[len(prefix):].partition(":")[0]


class DelegationAclTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.ds = Dataset()
        self.g = self.ds.get_context(URIRef(HOLONS))
        self.g.parse(data=FIXTURE, format="turtle")
        self.q = _query_fn(self.ds)
        self.now = datetime.now(timezone.utc)

    def delegate(self, *, iri="urn:example:delegation:d1", to=PA, perms=("read", "write"),
                 graphs=(KURT_HOLONS,), start=None, days=7, by=KURT):
        start = start or self.now - timedelta(hours=1)
        self.g.parse(
            data=dg.build_delegation(
                delegation_iri=iri, delegator=by, delegate=to, persona=PERSONA,
                graphs=graphs, permissions=perms, valid_from=start,
                valid_until=start + timedelta(days=days),
            ),
            format="turtle",
        )
        return iri

    async def write(self, target, person=PA):
        return await check_write(self.q, HOLONS, person=person, target=target)

    async def read(self, sparql, person=PA):
        return await authorize_query(
            self.q, HOLONS, person=person, sparql_text=sparql,
            persona_of_graph=persona_of_graph,
        )

    # --- check_write ---------------------------------------------------------

    async def test_no_delegation_no_write(self) -> None:
        self.assertFalse((await self.write(KURT_HOLONS)).allowed)

    async def test_active_write_delegation_allows_the_covered_graph(self) -> None:
        iri = self.delegate()
        decision = await self.write(KURT_HOLONS)
        self.assertTrue(decision.allowed)
        self.assertEqual(decision.matched_grant, iri)
        self.assertIn(KURT, decision.reason)
        self.assertEqual(decision.person, PA)

    async def test_uncovered_graphs_of_the_same_delegator_stay_denied(self) -> None:
        self.delegate(graphs=(KURT_HOLONS,))
        self.assertFalse((await self.write(KURT_SCENE)).allowed)

    async def test_someone_elses_graph_stays_denied(self) -> None:
        self.delegate()
        self.assertFalse((await self.write(OTHER_HOLONS)).allowed)

    async def test_ground_truth_stays_denied(self) -> None:
        self.delegate()
        self.assertFalse((await self.write(GROUND_TRUTH)).allowed)

    async def test_read_only_delegation_does_not_permit_writes(self) -> None:
        self.delegate(perms=("read",))
        self.assertFalse((await self.write(KURT_HOLONS)).allowed)

    async def test_delegation_is_to_one_person_only(self) -> None:
        self.delegate()
        self.assertFalse((await self.write(KURT_HOLONS, person=OTHER)).allowed)

    async def test_expired_delegation_denies(self) -> None:
        self.delegate(start=self.now - timedelta(days=10), days=7)
        self.assertFalse((await self.write(KURT_HOLONS)).allowed)

    async def test_future_delegation_denies(self) -> None:
        self.delegate(start=self.now + timedelta(days=1))
        self.assertFalse((await self.write(KURT_HOLONS)).allowed)

    async def test_revoked_delegation_denies(self) -> None:
        iri = self.delegate()
        self.assertTrue((await self.write(KURT_HOLONS)).allowed)
        self.ds.update(dg.revoke_update(HOLONS, iri, self.now))
        self.assertFalse((await self.write(KURT_HOLONS)).allowed)

    async def test_deactivating_the_delegator_ends_the_delegation(self) -> None:
        self.delegate()
        self.g.parse(data=f'@prefix holon: <{HOLON}> . <{KURT}> holon:status "inactive" .',
                     format="turtle")
        self.assertFalse((await self.write(KURT_HOLONS)).allowed)

    async def test_explicit_grants_writes_still_work_unchanged(self) -> None:
        self.g.parse(data=f"@prefix holon: <{HOLON}> . <{OTHER_HOLONS}> holon:grantsWrite <{PA}> .",
                     format="turtle")
        decision = await self.write(OTHER_HOLONS)
        self.assertTrue(decision.allowed)
        self.assertEqual(decision.reason, "explicit grantsWrite")

    async def test_admin_bypass_unchanged(self) -> None:
        self.g.parse(data=f"@prefix holon: <{HOLON}> . <{OTHER}> holon:hasRole <urn:example:role:admin> .",
                     format="turtle")
        decision = await self.write(KURT_HOLONS, person=OTHER)
        self.assertTrue(decision.allowed)
        self.assertEqual(decision.reason, "admin role bypass")

    async def test_scratch_targets_are_never_reached_by_a_delegation(self) -> None:
        # Even a (hand-forged) delegation naming a scratch graph must not
        # satisfy check_write: the scratch path resolves to a namespace-
        # level grant only.
        scratch = "urn:example:scratch:abc123"
        self.delegate(graphs=(scratch,))
        self.assertFalse((await self.write(scratch)).allowed)

    # --- check_replace: no delegation can ever satisfy it -------------------

    async def test_write_delegation_does_not_confer_replace(self) -> None:
        self.delegate(perms=("read", "write"))
        self.assertTrue((await self.write(KURT_HOLONS)).allowed)
        decision = await check_replace(self.q, HOLONS, person=PA, target=KURT_HOLONS)
        self.assertFalse(decision.allowed)
        self.assertIn("replace is stricter", decision.reason)

    async def test_a_forged_replace_permission_still_cannot_reach_replace(self) -> None:
        # Bypassing the validator by writing the triple by hand must not help:
        # check_replace never reads delegations at all.
        self.g.parse(
            data=dg.build_delegation(
                delegation_iri="urn:example:delegation:forged", delegator=KURT, delegate=PA,
                persona=PERSONA, graphs=[KURT_HOLONS], permissions=["write"],
                valid_from=self.now - timedelta(hours=1), valid_until=self.now + timedelta(days=1),
            ).replace('"write"', '"replace"'),
            format="turtle",
        )
        self.assertFalse((await check_replace(self.q, HOLONS, person=PA, target=KURT_HOLONS)).allowed)
        self.assertFalse((await self.write(KURT_HOLONS)).allowed)

    # --- authorize_query -----------------------------------------------------

    async def test_read_denied_without_delegation(self) -> None:
        q = f"SELECT * WHERE {{ GRAPH <{KURT_HOLONS}> {{ ?s ?p ?o }} }}"
        decision = await self.read(q)
        self.assertFalse(decision.allowed)
        self.assertIn("no ReadGrant", decision.reason)

    async def test_read_delegation_clears_the_covered_graph(self) -> None:
        self.delegate(perms=("read",))
        q = f"SELECT * WHERE {{ GRAPH <{KURT_HOLONS}> {{ ?s ?p ?o }} }}"
        self.assertTrue((await self.read(q)).allowed)

    async def test_write_only_delegation_does_not_permit_reads(self) -> None:
        self.delegate(perms=("write",))
        q = f"SELECT * WHERE {{ GRAPH <{KURT_HOLONS}> {{ ?s ?p ?o }} }}"
        self.assertFalse((await self.read(q)).allowed)

    async def test_one_uncovered_graph_denies_the_whole_query(self) -> None:
        self.delegate(perms=("read",), graphs=(KURT_HOLONS,))
        q = (f"SELECT * WHERE {{ GRAPH <{KURT_HOLONS}> {{ ?s ?p ?o }} "
             f"GRAPH <{KURT_SCENE}> {{ ?s2 ?p2 ?o2 }} }}")
        decision = await self.read(q)
        self.assertFalse(decision.allowed)
        self.assertIn(KURT_SCENE, decision.reason)

    async def test_a_delegation_does_not_reach_a_third_persons_graph(self) -> None:
        self.delegate(perms=("read",))
        q = f"SELECT * WHERE {{ GRAPH <{OTHER_HOLONS}> {{ ?s ?p ?o }} }}"
        self.assertFalse((await self.read(q)).allowed)

    async def test_read_delegation_can_cover_both_graph_roles(self) -> None:
        self.delegate(perms=("read",), graphs=(KURT_HOLONS, KURT_SCENE))
        q = (f"SELECT * WHERE {{ GRAPH <{KURT_HOLONS}> {{ ?s ?p ?o }} "
             f"GRAPH <{KURT_SCENE}> {{ ?s2 ?p2 ?o2 }} }}")
        self.assertTrue((await self.read(q)).allowed)

    async def test_expired_and_revoked_reads_are_denied(self) -> None:
        iri = self.delegate(perms=("read",))
        q = f"SELECT * WHERE {{ GRAPH <{KURT_HOLONS}> {{ ?s ?p ?o }} }}"
        self.assertTrue((await self.read(q)).allowed)
        self.ds.update(dg.revoke_update(HOLONS, iri, self.now))
        self.assertFalse((await self.read(q)).allowed)

    async def test_unparseable_query_is_still_denied(self) -> None:
        self.delegate(perms=("read",))
        self.assertFalse((await self.read("this is not sparql")).allowed)

    async def test_an_update_touching_a_delegated_graph_needs_write_not_read(self) -> None:
        # routes/sparql.py gates updates with check_write per graph, so a
        # read-only delegation must not let an update through.
        self.delegate(perms=("read",))
        self.assertFalse((await self.write(KURT_HOLONS)).allowed)


if __name__ == "__main__":
    unittest.main()
