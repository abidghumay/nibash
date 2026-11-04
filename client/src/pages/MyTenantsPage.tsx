import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiClient } from "../api/client";
import { bdt, dhakaDate, dmpLabel } from "../api/rentals";
import "../styles/rental-management.css";
interface Tenant {
  contract_id: number;
  tenant_id: number;
  tenant_name: string;
  listing_title: string;
  unit_floor: number;
  area_name: string;
  city: string;
  start_date: string;
  end_date: string;
  tenancy_started_on: string | null;
  status: string;
  effective_rent: string;
  next_due: string | null;
  latest_payment_status: string | null;
  dmp_status: string;
  tenant_group: string;
}
export function MyTenantsPage() {
  const [data, setData] = useState<{
    tenants: Tenant[];
    pagination: { total: number; totalPages: number };
  } | null>(null);
  const [group, setGroup] = useState("all");
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setData(null);
    apiClient
      .get<{
        tenants: Tenant[];
        pagination: { total: number; totalPages: number };
      }>(`/rental/tenants?group=${group}&page=${page}`, {
        signal: controller.signal,
      })
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [group, page, refresh]);
  return (
    <div className="rental-management max-w-7xl mx-auto px-4 py-10 sm:px-8">
      <div className="rental-heading">
        <div>
          <p className="rental-eyebrow">LANDLORD / RENTAL RELATIONSHIPS</p>
          <h1>My Tenants</h1>
          <p className="rental-muted">
            Agreements, protected rent and payment records for the properties
            you manage.
          </p>
        </div>
        <Link className="rental-button" to="/owner/income">
          Rental income ↗
        </Link>
      </div>
      <div
        className="rental-toolbar"
        role="group"
        aria-label="Filter rental relationships"
      >
        {["all", "current", "upcoming", "former"].map((value) => (
          <button
            key={value}
            className="rental-button"
            aria-pressed={group === value}
            onClick={() => {
              setGroup(value);
              setPage(1);
            }}
          >
            {value[0].toUpperCase() + value.slice(1)}
          </button>
        ))}
        <span className="rental-muted">
          {data ? `${data.pagination.total} relationships` : ""}
        </span>
      </div>
      {loading && (
        <p role="status" className="rental-card">
          Loading your rental relationships…
        </p>
      )}
      {error && (
        <div role="alert" className="rental-card rental-error">
          <p>{error}</p>
          <button
            className="rental-button"
            onClick={() => setRefresh((v) => v + 1)}
          >
            Retry
          </button>
        </div>
      )}
      {data && !data.tenants.length && (
        <div className="rental-card">
          <h2>No {group === "all" ? "" : group + " "}tenants yet</h2>
          <p className="rental-muted">
            Rental relationships appear here after you propose an agreement for
            an applicant.
          </p>
          <Link className="rental-button" to="/my-listings">
            View my listings
          </Link>
        </div>
      )}
      {!!data?.tenants.length && (
        <div
          className="rental-table-wrapper"
          tabIndex={0}
          role="region"
          aria-label="Your tenants"
        >
          <table className="rental-table">
            <caption className="sr-only">
              Authorized rental relationships
            </caption>
            <thead>
              <tr>
                {[
                  "Tenant / property",
                  "Agreement",
                  "Monthly rent",
                  "Next due / payment",
                  "DMP preparation",
                ].map((h) => (
                  <th key={h} scope="col">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.tenants.map((tenant) => (
                <tr key={tenant.contract_id}>
                  <th scope="row">
                    <Link
                      to={`/contracts/${tenant.contract_id}`}
                      className="rental-tenant-link"
                    >
                      {tenant.tenant_name}
                      <span>{tenant.listing_title}</span>
                    </Link>
                    <Link to={`/contracts/${tenant.contract_id}#move-out-inspection`} className="rental-tenant-link">Move-out inspection</Link>
                    <small className="rental-muted">
                      Floor {tenant.unit_floor} · {tenant.area_name},{" "}
                      {tenant.city}
                    </small>
                  </th>
                  <td data-label="Agreement">
                    <span className="rental-badge">
                      {tenant.tenant_group} · {tenant.status}
                    </span>
                    <small>
                      From{" "}
                      {dhakaDate(
                        tenant.tenancy_started_on ?? tenant.start_date,
                      )}
                      <br />
                      Expires {dhakaDate(tenant.end_date)}
                    </small>
                  </td>
                  <td data-label="Monthly rent" className="rental-money">
                    {bdt(tenant.effective_rent)}
                  </td>
                  <td data-label="Next due / payment">
                    {dhakaDate(tenant.next_due)}
                    <small>
                      {tenant.latest_payment_status ?? "No payment yet"}
                    </small>
                  </td>
                  <td data-label="DMP preparation">
                    {dmpLabel[tenant.dmp_status] ?? "Not prepared"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.pagination.totalPages > 1 && (
        <nav aria-label="Tenant pages" className="rental-toolbar">
          <button
            className="rental-button"
            disabled={page === 1}
            onClick={() => setPage((v) => v - 1)}
          >
            Previous
          </button>
          <span>
            Page {page} of {data.pagination.totalPages}
          </span>
          <button
            className="rental-button"
            disabled={page >= data.pagination.totalPages}
            onClick={() => setPage((v) => v + 1)}
          >
            Next
          </button>
        </nav>
      )}
      <p className="rental-muted mt-6">
        DMP status is preparation tracking reported by the landlord. It does not
        establish police submission or approval.
      </p>
    </div>
  );
}
