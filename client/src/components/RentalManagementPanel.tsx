import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { FormEvent } from "react";
import { apiClient } from "../api/client";
import {
  bdt,
  dhakaDate,
  dmpLabel,
  downloadRentalDocument,
} from "../api/rentals";
import type { RentalDetails } from "../api/rentals";
import "../styles/rental-management.css";
const sections = [
  "Agreements",
  "Payments",
  "Notifications",
  "DMP preparation",
  "Move-out",
  "Sources",
];
const documentName: Record<string, string> = {
  draft: "DRAFT agreement",
  agreement: "Finalized accepted agreement",
  amendment: "Accepted rent amendment",
  acknowledgment: "Electronic payment acknowledgment",
  reversal: "Linked reversal acknowledgment",
};
export function RentalManagementPanel({
  contractId,
  userId,
}: {
  contractId: string;
  userId: number;
}) {
  const [data, setData] = useState<RentalDetails | null>(null);
  const [section, setSection] = useState("Agreements");
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [dmpStatus, setDmpStatus] = useState("not_prepared");
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    apiClient
      .get<RentalDetails>(`/rental/contracts/${contractId}`, {
        signal: controller.signal,
      })
      .then((value) => {
        if (!controller.signal.aborted) {
          setData(value);
          setDmpStatus(value.dmp.status);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [contractId, refresh]);
  async function action(work: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
      setMessage(success);
      setRefresh((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return (
      <section
        className="rental-management rental-card"
        aria-label="Rental management"
      >
        {error ? (
          <div role="alert">
            {error}
            <button
              className="rental-button"
              onClick={() => setRefresh((v) => v + 1)}
            >
              Retry rental records
            </button>
          </div>
        ) : (
          <p role="status">Loading protected rental records…</p>
        )}
      </section>
    );
  const c = data.contract;
  const isOwner = c.owner_id === userId;
  const isTenant = c.tenant_id === userId;
  const submitRevision = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void action(
      () =>
        apiClient.post(`/rental/contracts/${contractId}/revisions`, {
          rent: String(form.get("rent")),
          effective_on: String(form.get("effective_on")),
        }),
      "Proposal sent for tenant review. Current invoices stay unchanged.",
    );
  };
  return (
    <section className="rental-management mb-8" aria-label="Rental management">
      <div className="rental-card">
        <div className="rental-heading">
          <div>
            <p className="rental-eyebrow">YOUR RENTAL RECORD</p>
            <h2>Protection, documents & payments</h2>
          </div>
          <button
            className="rental-button"
            disabled={busy}
            onClick={() => setRefresh((v) => v + 1)}
          >
            Refresh records
          </button>
        </div>
        <dl className="rental-grid">
          <div className="rental-stat">
            <dt>Current effective monthly rent</dt>
            <dd>{bdt(c.effective_rent ?? c.rent)}</dd>
          </div>
          <div className="rental-stat">
            <dt>Advance rent agreed</dt>
            <dd>{bdt(c.advance_rent)}</dd>
          </div>
          <div className="rental-stat">
            <dt>Original protected rent</dt>
            <dd>
              {c.initial_rent
                ? bdt(c.initial_rent)
                : "Verification / acceptance needed"}
            </dd>
          </div>
          <div className="rental-stat">
            <dt>Ordinary increase eligible from</dt>
            <dd>{dhakaDate(c.protection_until)}</dd>
          </div>
        </dl>
        {c.protection_state === "needs_verification" ? (
          <p className="rental-card rental-warning">
            Verification needed: this historical agreement has no established
            continuing-tenancy baseline. Its past changes have not been
            certified under this policy.
          </p>
        ) : (
          <p className="rental-muted mt-5">
            Nibash’s 24-month protection is a contractual platform policy.
            Ordinary increases require tenant acceptance and cannot take effect
            before the eligible date. Renewal preserves the original history.
          </p>
        )}
        {Number(c.security_deposit) > 0 && (
          <p className="rental-card rental-warning">
            Historical deposit record: {bdt(c.security_deposit)}. Retained for
            accounting and disputes; lawfulness and collection are not approved
            here.
          </p>
        )}
        <div
          className="rental-toolbar"
          role="group"
          aria-label="Rental record sections"
        >
          {sections.map((value) => (
            <button
              className="rental-button"
              key={value}
              aria-pressed={value === section}
              onClick={() => setSection(value)}
            >
              {value}
            </button>
          ))}
        </div>
        {error && (
          <p role="alert" className="rental-card rental-error">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="rental-card">
            {message}
          </p>
        )}
        {section === "Agreements" && (
          <>
            <h3>Agreement documents & previous versions</h3>
            {isOwner &&
              c.status === "signed" &&
              c.protection_state === "verified" && (
                <Link
                  className="rental-button mb-3"
                  to={`/contracts/new?listingId=${c.listing_id}&tenantId=${c.tenant_id}&previousContractId=${c.contract_id}`}
                >
                  Propose continuing renewal
                </Link>
              )}
            <p className="rental-muted">
              Account acceptance is recorded without inventing a signature. A
              PDF does not register a lease. Leases exceeding one year require
              legal execution review.
            </p>
            {!data.documents.length && (
              <p className="rental-muted">
                No captured agreement version yet. Historical agreements require
                review before a finalized document can be issued.
              </p>
            )}
            {data.documents
              .filter((d) =>
                ["draft", "agreement", "amendment"].includes(d.kind),
              )
              .map((d) => (
                <div className="rental-record" key={d.id}>
                  <div>
                    <p>
                      {documentName[d.kind]} · NIBASH-{d.id}
                    </p>
                    <small>
                      {dhakaDate(d.issued_at)} ·{" "}
                      {d.state === "ready"
                        ? "PDF ready"
                        : "Preparing PDF — refresh shortly"}
                    </small>
                    {d.pdf_sha256 && (
                      <small className="break-all">
                        SHA-256 {d.pdf_sha256}
                      </small>
                    )}
                  </div>
                  <button
                    className="rental-button"
                    disabled={busy}
                    onClick={() =>
                      void action(
                        () => downloadRentalDocument(d.id),
                        "Document downloaded",
                      )
                    }
                  >
                    Download PDF
                  </button>
                </div>
              ))}
            <h3 className="mt-7">Rent revisions</h3>
            {!data.revisions.length && (
              <p className="rental-muted">No rent amendments proposed.</p>
            )}
            {data.revisions.map((r) => (
              <div className="rental-record" key={r.id}>
                <div>
                  <p>
                    {bdt(r.previous_rent)} → {bdt(r.proposed_rent)}
                  </p>
                  <small>
                    Effective {dhakaDate(r.effective_on)} · {r.status}
                  </small>
                </div>
                {isTenant && r.status === "proposed" && (
                  <div className="rental-toolbar">
                    <button
                      className="rental-button"
                      disabled={busy}
                      onClick={() => {
                        if (
                          confirm(
                            `Accept monthly rent of ${bdt(r.proposed_rent)} from ${dhakaDate(r.effective_on)}? You can decline this proposal.`,
                          )
                        )
                          void action(
                            () =>
                              apiClient.patch(`/rental/revisions/${r.id}`, {
                                accept: true,
                              }),
                            "Acceptance recorded",
                          );
                      }}
                    >
                      Accept proposal
                    </button>
                    <button
                      className="rental-button"
                      disabled={busy}
                      onClick={() =>
                        void action(
                          () =>
                            apiClient.patch(`/rental/revisions/${r.id}`, {
                              accept: false,
                            }),
                          "Proposal declined",
                        )
                      }
                    >
                      Decline
                    </button>
                  </div>
                )}
              </div>
            ))}
            {isOwner &&
              c.protection_state === "verified" &&
              c.status === "signed" && (
                <form onSubmit={submitRevision} className="rental-card">
                  <fieldset>
                    <legend>Propose a rent revision</legend>
                    <div className="rental-grid">
                      <div>
                        <label htmlFor="revised-rent">
                          Proposed monthly rent (BDT)
                        </label>
                        <input
                          id="revised-rent"
                          name="rent"
                          type="number"
                          inputMode="decimal"
                          min="0.01"
                          step="0.01"
                          required
                          aria-describedby="revision-guidance"
                        />
                      </div>
                      <div>
                        <label htmlFor="revision-date">Effective date</label>
                        <input
                          id="revision-date"
                          name="effective_on"
                          type="date"
                          required
                        />
                      </div>
                    </div>
                    <p id="revision-guidance" className="rental-muted my-3">
                      Earliest increase date: {dhakaDate(c.protection_until)}.
                      The backend checks protection and the tenant chooses
                      whether to accept.
                    </p>
                    <button
                      className="rental-button"
                      disabled={busy}
                      type="submit"
                    >
                      Send proposal for review
                    </button>
                  </fieldset>
                </form>
              )}
          </>
        )}
        {section === "Payments" && (
          <>
            <h3>Invoices & actual receipts</h3>
            <p className="rental-muted">
              Cash marked paid remains unconfirmed until the landlord
              acknowledges receipt. Transfer methods are recorded declarations;
              Nibash has no independent payment-provider verification here.
            </p>
            {!data.payments.length && (
              <p className="rental-muted">
                No invoices yet. Monthly billing starts on the agreement’s
                effective date.
              </p>
            )}
            {data.payments.map((p) => (
              <div className="rental-card" key={p.id}>
                <div className="rental-heading">
                  <div>
                    <h3>
                      Invoice #{p.id} · {p.category}
                    </h3>
                    <small>
                      Due {dhakaDate(p.due_date)} · {p.status}
                    </small>
                  </div>
                  <strong>{bdt(p.outstanding_balance)} outstanding</strong>
                </div>
                <p className="rental-muted">
                  Amount due {bdt(p.amount)} · Confirmed cash / transfer{" "}
                  {bdt(p.confirmed_amount)} · Advance credit applied{" "}
                  {bdt(p.advance_credit)}
                </p>
                {isTenant &&
                  ["pending", "overdue"].includes(p.status) &&
                  !data.events.some(
                    (e) => e.payment_id === p.id && e.status === "pending",
                  ) && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const amount = String(
                          new FormData(e.currentTarget).get("amount"),
                        );
                        if (
                          confirm(
                            `Record ${bdt(amount)} paid by cash? This awaits landlord confirmation.`,
                          )
                        )
                          void action(
                            () =>
                              apiClient.patch(`/payments/${p.id}/pay-cash`, {
                                amount,
                                request_key: crypto.randomUUID(),
                              }),
                            "Cash claim saved; awaiting landlord confirmation",
                          );
                      }}
                    >
                      <label htmlFor={`installment-${p.id}`}>
                        Cash amount actually paid (BDT)
                      </label>
                      <input
                        id={`installment-${p.id}`}
                        name="amount"
                        type="number"
                        min="0.01"
                        max={p.outstanding_balance}
                        step="0.01"
                        defaultValue={p.outstanding_balance}
                        required
                      />
                      <button
                        className="rental-button mt-3"
                        type="submit"
                        disabled={busy}
                      >
                        Record cash paid
                      </button>
                    </form>
                  )}
              </div>
            ))}
            <h3>Installment history & acknowledgments</h3>
            {!data.events.length && (
              <p className="rental-muted">
                No installment events recorded. Older confirmed payment records
                remain in the existing payment history.
              </p>
            )}
            {data.events.map((event) => (
              <div className="rental-record" key={event.id}>
                <div>
                  <p>
                    {bdt(event.amount)} · {event.method} ·{" "}
                    {event.reversal_id ? "Reversed" : event.status}
                  </p>
                  <small>
                    Invoice #{event.payment_id} ·{" "}
                    {dhakaDate(event.confirmed_at)}
                  </small>
                  {event.reversal_reason && (
                    <small>Correction: {event.reversal_reason}</small>
                  )}
                </div>
                <div className="rental-toolbar">
                  {event.status === "pending" && isOwner && (
                    <>
                      <button
                        disabled={busy}
                        className="rental-button"
                        onClick={() => {
                          if (
                            confirm(
                              `Confirm you actually received ${bdt(event.amount)}? A permanent electronic acknowledgment will be issued with your account attribution.`,
                            )
                          )
                            void action(
                              () =>
                                apiClient.post(
                                  `/rental/events/${event.id}/confirm`,
                                  {},
                                ),
                              "Installment confirmed; acknowledgment queued",
                            );
                        }}
                      >
                        Confirm amount received
                      </button>
                      <button
                        disabled={busy}
                        className="rental-button"
                        onClick={() =>
                          void action(
                            () =>
                              apiClient.patch(
                                `/payments/${event.payment_id}/reject-cash`,
                                {},
                              ),
                            "Claim rejected",
                          )
                        }
                      >
                        Did not receive
                      </button>
                    </>
                  )}
                  {event.document_id && (
                    <button
                      disabled={busy}
                      className="rental-button"
                      onClick={() =>
                        void action(
                          () => downloadRentalDocument(event.document_id!),
                          "Acknowledgment downloaded",
                        )
                      }
                    >
                      Download acknowledgment
                    </button>
                  )}
                  {event.status === "confirmed" &&
                    !event.reversal_id &&
                    isOwner && (
                      <button
                        disabled={busy}
                        className="rental-button"
                        onClick={() => {
                          const reason = prompt(
                            "Reason for reversal (5–500 characters). Original acknowledgment will remain.",
                          );
                          if (
                            reason &&
                            confirm("Record this linked financial correction?")
                          )
                            void action(
                              () =>
                                apiClient.post(
                                  `/rental/events/${event.id}/reversal`,
                                  { reason },
                                ),
                              "Reversal recorded; original preserved",
                            );
                        }}
                      >
                        Record reversal
                      </button>
                    )}
                </div>
              </div>
            ))}
            {data.documents
              .filter((d) => d.kind === "reversal")
              .map((d) => (
                <div className="rental-record" key={d.id}>
                  <span>Linked reversal document NIBASH-{d.id}</span>
                  <button
                    disabled={busy}
                    className="rental-button"
                    onClick={() =>
                      void action(
                        () => downloadRentalDocument(d.id),
                        "Correction downloaded",
                      )
                    }
                  >
                    Download correction
                  </button>
                </div>
              ))}
          </>
        )}
        {section === "Notifications" && (
          <>
            <h3>Rental notifications</h3>
            <Link className="rental-button" to="/inbox">
              Open your inbox
            </Link>
            {!data.notifications?.length && (
              <p className="rental-muted">
                No notifications for this rental relationship yet.
              </p>
            )}
            {data.notifications?.map((n) => (
              <article key={n.id} className="rental-record">
                <div>
                  <h3>{n.title}</h3>
                  <p>{n.body}</p>
                  <small>{dhakaDate(n.created_at)}</small>
                </div>
              </article>
            ))}
          </>
        )}
        {section === "DMP preparation" && (
          <>
            <h3>DMP information preparation</h3>
            <p className="rental-card rental-warning">
              {data.dmp_guidance.message} Nothing is submitted to police through
              this feature.
            </p>
            <p>
              Preparation status:{" "}
              <strong>{dmpLabel[data.dmp.status] ?? "Not prepared"}</strong>
            </p>
            <p className="rental-muted">
              {c.tenant_name} · {c.tenant_email} · {c.tenant_phone}
              <br />
              {c.listing_title} · {c.property_address} · Agreement #
              {c.contract_id} · {dhakaDate(c.start_date)}
            </p>
            {data.dmp.submission_date && (
              <p>
                Self-reported submission date:{" "}
                {dhakaDate(data.dmp.submission_date)}
                <br />
                Self-reported reference:{" "}
                {data.dmp.self_reported_reference ?? "Not supplied"}
              </p>
            )}
            <div className="rental-toolbar">
              <a
                className="rental-button"
                href={data.dmp_guidance.form_url}
                target="_blank"
                rel="noreferrer"
              >
                Official DMP form ↗
              </a>
              <a
                className="rental-button"
                href={data.dmp_guidance.information_url}
                target="_blank"
                rel="noreferrer"
              >
                Official CIMS information ↗
              </a>
            </div>
            {isOwner && c.status !== "proposed" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void action(
                    () =>
                      apiClient.patch(`/rental/contracts/${contractId}/dmp`, {
                        status: dmpStatus,
                        submission_date:
                          dmpStatus === "submitted_manually_unverified"
                            ? String(f.get("submission_date") || "") || null
                            : null,
                        self_reported_reference:
                          dmpStatus === "submitted_manually_unverified"
                            ? String(f.get("reference") || "") || null
                            : null,
                      }),
                    "Self-reported preparation status saved",
                  );
                }}
              >
                <fieldset>
                  <legend>Update preparation tracking</legend>
                  {Object.entries(dmpLabel).map(([value, label]) => (
                    <label key={value}>
                      <input
                        type="radio"
                        name="dmp_status"
                        value={value}
                        checked={dmpStatus === value}
                        onChange={() => setDmpStatus(value)}
                      />
                      {label}
                    </label>
                  ))}
                  {dmpStatus === "submitted_manually_unverified" && (
                    <>
                      <label htmlFor="dmp-date">
                        Manual submission date (self-reported)
                      </label>
                      <input
                        type="date"
                        id="dmp-date"
                        name="submission_date"
                        defaultValue={data.dmp.submission_date?.slice(0, 10)}
                      />
                      <label htmlFor="dmp-reference">
                        Reference (optional; no identity numbers)
                      </label>
                      <input
                        id="dmp-reference"
                        name="reference"
                        maxLength={120}
                        defaultValue={data.dmp.self_reported_reference ?? ""}
                      />
                    </>
                  )}
                  <button
                    className="rental-button mt-3"
                    disabled={busy}
                    type="submit"
                  >
                    Save tracking status
                  </button>
                </fieldset>
              </form>
            )}
            {isTenant && (
              <form
                className="rental-card"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void action(
                    () =>
                      apiClient.post(
                        `/rental/contracts/${contractId}/correction`,
                        { message: String(f.get("correction")) },
                      ),
                    "Correction request sent",
                  );
                }}
              >
                <label htmlFor="tenant-correction">
                  Request an information correction
                </label>
                <textarea
                  id="tenant-correction"
                  name="correction"
                  minLength={10}
                  maxLength={1000}
                  required
                  aria-describedby="correction-privacy"
                />
                <p id="correction-privacy" className="rental-muted">
                  Describe the correction without adding NID/passport numbers,
                  identity images or household-member details.
                </p>
                <button
                  disabled={busy}
                  type="submit"
                  className="rental-button mt-3"
                >
                  Send correction request
                </button>
              </form>
            )}
          </>
        )}
        {section === "Move-out" && (
          <>
            <h3>Move-out, inspection & settlement</h3>
            <p className="rental-muted">
              Agreement expiry: {dhakaDate(c.end_date)}. Occupancy:{" "}
              {c.occupancy_state}. Expiry does not establish vacancy. Both
              parties must confirm the same actual move-out, inspection and
              settlement record before final closure.
            </p>
            {c.status === "signed" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  if (
                    confirm(
                      "Confirm this actual move-out, inspection and settlement record? After both parties confirm, the listing may become available. Original records remain.",
                    )
                  )
                    void action(
                      () =>
                        apiClient.post(
                          `/rental/contracts/${contractId}/close`,
                          {
                            move_out_date: String(f.get("move_out_date")),
                            inspection_note: String(f.get("inspection_note")),
                            settlement_note: String(f.get("settlement_note")),
                          },
                        ),
                      "Move-out confirmation recorded",
                    );
                }}
              >
                <label htmlFor="move-out-date">Actual move-out date</label>
                <input
                  id="move-out-date"
                  type="date"
                  name="move_out_date"
                  required
                  defaultValue={c.move_out_date?.slice(0, 10)}
                />
                <label htmlFor="inspection">Inspection record</label>
                <textarea
                  id="inspection"
                  name="inspection_note"
                  required
                  minLength={5}
                  maxLength={1000}
                  defaultValue={c.inspection_note ?? ""}
                />
                <label htmlFor="settlement">
                  Settlement record (include any unresolved balance)
                </label>
                <textarea
                  id="settlement"
                  name="settlement_note"
                  required
                  minLength={5}
                  maxLength={1000}
                  defaultValue={c.settlement_note ?? ""}
                />
                <p className="rental-muted">
                  Owner confirmed: {c.owner_closed_at ? "Yes" : "No"} · Tenant
                  confirmed: {c.tenant_closed_at ? "Yes" : "No"}
                </p>
                <button
                  className="rental-button mt-3"
                  type="submit"
                  disabled={busy}
                >
                  Confirm move-out record
                </button>
              </form>
            )}
          </>
        )}
        {section === "Sources" && (
          <>
            {data.rules.map((rule) => (
              <article className="rental-record" key={rule.id}>
                <div>
                  <h3>{rule.title}</h3>
                  <small>
                    {rule.id} · {rule.source_type.replaceAll("_", " ")}
                  </small>
                  <p className="rental-muted">{rule.assumptions}</p>
                  <p>{rule.verification_status}</p>
                  {rule.source_url && (
                    <a
                      href={rule.source_url}
                      target="_blank"
                      rel="noreferrer"
                      className="rental-button mt-3"
                    >
                      Official source ↗
                    </a>
                  )}
                </div>
              </article>
            ))}
          </>
        )}
      </div>
    </section>
  );
}
