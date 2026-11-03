# Area system

The database is the catalog of area IDs, names, and cities. `GET /api/areas`
includes areas with no approved listings. `GET /api/areas/stats` keeps its existing
contract and only includes areas with approved listings. Deploy the server before
the updated client, which requires the catalog endpoint. Catalog failures show a
retry action; the UI never substitutes hardcoded seed IDs.

## Coverage and assignment

New listings and moved pins must lie within the inclusive operating envelope:
latitude **23.65–23.95**, longitude **90.30–90.55**. This rectangle is an initial
product coverage decision around Dhaka, **not an official administrative boundary**.
It deliberately includes space between the seeded neighborhoods. The bounds live
in `server/src/services/areaCoverage.ts`; replace that policy with a verified
service polygon when precise geographic coverage is established.

Inside this envelope, the server assigns the nearest valid center from database
areas whose city is Dhaka. This remains an approximate neighborhood label, not a
claim that a point lies inside an official neighborhood. Equal-distance centers
use the smaller database ID for deterministic results. Empty or invalid catalogs
cannot assign an area. Stored `radius` values remain for schema compatibility;
the old 500-meter circles do not determine service coverage.

Creation derives the area from coordinates even if an older client submits an
`area_id`. On edits, a row lock and transaction keep coordinates, derived area,
lease terms and amenities consistent. A partial coordinate patch retains the
other coordinate. A conflicting explicit area override is rejected.

No migration, renumbering, deletion or automatic reclassification is performed.
Existing locations remain editable without movement, even outside the new
envelope. The edit form preserves valid zero coordinates. A legacy pin must move
into supported coverage if its coordinates change. Existing approval/status
rules are unchanged.

## Search

Name-based URLs and numeric IDs remain supported. Ordinary parsing uses database
names and the same explicit aliases used by AI search, with longer area names
matched first. Explicit names also support server-side typo matching. Unresolved,
invalid or conflicting explicit area filters return HTTP 400; the server never
silently drops an area constraint. Search responses add `resolvedAreaId` so owner
and verifier collections can use the same resolution as public search.

Frontend lookups use exact catalog names rather than partial substring guesses.
An unresolved/loading/failed filtered search does not display unfiltered public
listings. Existing `near` queries still select a named area; distance-based search,
sector hierarchies, and official neighborhood polygons are not implemented.

## Verification

Run `npm test` and `npm run build` in `server/`, and `npm test`, `npm run build`,
and `npm run lint` in `client/`. Server tests use isolated PostgreSQL fixtures,
including shifted area IDs, newly added areas, coordinate edits, rollback,
unresolved search, legacy locations, and catalog/statistics compatibility.
Client tests mount real React components with a simulated Maps SDK to verify late
coordinates, cleanup, catalog loading/retry, alias filters and unchanged legacy
form submissions. No production database is required for these tests.
