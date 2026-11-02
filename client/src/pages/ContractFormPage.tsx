import { useState, useEffect } from "react";
import { useSearchParams, useNavigate, Link } from "react-router-dom";
import { apiClient } from "../api/client";
import { useAuth } from "../context/AuthContext";

export function ContractFormPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { token } = useAuth();

  const listingId = searchParams.get("listingId") || "";
  const tenantId = searchParams.get("tenantId") || "";
  const previousContractId=searchParams.get("previousContractId");

  // Contract form states
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  // Financial Terms (seeded from listing initial terms)
  const [rent, setRent] = useState("");
  const [electricityBill, setElectricityBill] = useState("");
  const [waterBill, setWaterBill] = useState("");
  const [serviceCharge, setServiceCharge] = useState("");
  const [monthlyDueDate, setMonthlyDueDate] = useState("");
  const [securityDeposit] = useState("0");
  const [advanceRent,setAdvanceRent]=useState("0");
  const [petAllowed, setPetAllowed] = useState(false);

  // Status
  const [loadingTerms, setLoadingTerms] = useState(true);
  const [termsError, setTermsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch listing initial terms on mount
  useEffect(() => {
    if (!listingId) {
      setTermsError("No listing ID provided.");
      setLoadingTerms(false);
      return;
    }
    setLoadingTerms(true);
    apiClient
      .get<{
        listing?: {
          rent: number | null;
          electricity_bill: number | null;
          water_bill: number | null;
          service_charge: number | null;
          monthly_due_date: number | null;
          pet_allowed: boolean | null;
          security_deposit: number | null;
        };
        contract?:{rent:number;electricity_bill:number;water_bill:number;service_charge:number;monthly_due_date:number;pet_allowed:boolean;security_deposit:number;end_date:string;effective_rent:number;renewal_rent:number};
      }>(previousContractId?`/contracts/${previousContractId}`:`/listings/${listingId}`)
      .then((data) => {
        const listing=data.contract??data.listing;
        if(!listing)throw new Error('Agreement terms unavailable');
        if(data.contract){const start=new Date(data.contract.end_date);start.setUTCDate(start.getUTCDate()+1);setStartDate(start.toISOString().slice(0,10));}

        setRent(data.contract ? String(data.contract.renewal_rent) : listing.rent != null ? String(listing.rent) : "");
        setElectricityBill(
          listing.electricity_bill != null ? String(listing.electricity_bill) : ""
        );
        setWaterBill(listing.water_bill != null ? String(listing.water_bill) : "");
        setServiceCharge(
          listing.service_charge != null ? String(listing.service_charge) : ""
        );
        setMonthlyDueDate(
          listing.monthly_due_date != null ? String(listing.monthly_due_date) : ""
        );

        setPetAllowed(listing.pet_allowed ?? false);
      })
      .catch((err: any) => {
        setTermsError(err.message || "Failed to load listing terms.");
      })
      .finally(() => setLoadingTerms(false));
  }, [listingId,previousContractId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (new Date(startDate) >= new Date(endDate)) {
      setError("End date must be strictly after the start date.");
      return;
    }

    setLoading(true);
    const payload = {
      listing_id: Number(listingId),
      tenant_id: Number(tenantId),
      start_date: startDate,
      end_date: endDate,
      rent: Number(rent),
      electricity_bill: Number(electricityBill),
      water_bill: Number(waterBill),
      service_charge: Number(serviceCharge),
      monthly_due_date: Number(monthlyDueDate),
      security_deposit: securityDeposit,
      advance_rent:advanceRent,
      ...(previousContractId?{previous_contract_id:Number(previousContractId)}:{}),
      pet_allowed: Boolean(petAllowed),
    };

    try {
      const res = await apiClient.post<{ message: string; contractId: number }>("/contracts", payload);
      alert(res.message || "Contract proposed successfully!");
      navigate(`/contracts/${res.contractId}`);
    } catch (err: any) {
      setError(err.message || "Failed to propose contract.");
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <div className="max-w-md mx-auto py-16 px-4 text-center">
        <h2 className="text-xl font-bold text-white mb-2">Authentication Required</h2>
        <p className="text-sm text-slate-400 mb-6">
          You must be logged in as the property owner to propose a lease contract.
        </p>
        <Link to="/login" className="bg-white text-slate-900 px-4 py-2 rounded text-xs font-medium">
          Log In
        </Link>
      </div>
    );
  }

  if (loadingTerms) {
    return (
      <div className="max-w-2xl mx-auto py-10 px-4 text-center text-slate-400 text-sm">
        Loading listing terms...
      </div>
    );
  }

  if (termsError) {
    return (
      <div className="max-w-2xl mx-auto py-10 px-4 text-center">
        <p className="text-red-400 text-sm mb-4">{termsError}</p>
        <Link to="/owner/applications" className="text-xs text-slate-400 hover:text-white">
          ← Back to Applications
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto py-10 px-4">
      <div className="mb-6">
        <Link to="/owner/applications" className="text-xs text-slate-400 hover:text-white">
          ← Back to Applications
        </Link>
      </div>

      <div className="border border-slate-800 bg-[#12151c] rounded-2xl p-6 sm:p-8">
        <h1 className="text-2xl font-bold text-white mb-1">Propose Digital Lease Contract</h1>
        <p className="text-xs text-slate-400 mb-6">
          Specify agreement duration and financial obligations for the approved tenant. Continuing renewals retain the original rent-protection history; new charges cannot bypass it.
        </p>

        {error && (
          <div className="p-3 mb-6 rounded bg-red-950/60 border border-red-800 text-red-300 text-xs">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="contract-start-date"
                className="block text-xs uppercase font-medium text-slate-300 mb-1"
              >
                Start Date *
              </label>
              <input
                id="contract-start-date"
                type="date"
                required
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full bg-[#0d1017] text-white border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-white focus:ring-1 focus:ring-white/20"
              />
            </div>
            <div>
              <label
                htmlFor="contract-end-date"
                className="block text-xs uppercase font-medium text-slate-300 mb-1"
              >
                End Date *
              </label>
              <input
                id="contract-end-date"
                type="date"
                required
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full bg-[#0d1017] text-white border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-white focus:ring-1 focus:ring-white/20"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-slate-800">
            <div>
              <label
                htmlFor="contract-rent"
                className="block text-xs uppercase font-medium text-slate-300 mb-1"
              >
                Monthly Rent (BDT) *
              </label>
              <input
                id="contract-rent"
                type="number"
                min="1000"
                step="500"
                required
                value={rent}
                onChange={(e) => setRent(e.target.value)}
                className="w-full bg-[#0d1017] text-white border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-white focus:ring-1 focus:ring-white/20"
              />
            </div>

            <div>
              <label
                htmlFor="contract-security-deposit"
                className="block text-xs uppercase font-medium text-slate-300 mb-1"
              >
                Security Deposit (BDT; unavailable)
              </label>
              <input
                id="contract-security-deposit"
                type="number"
                min="0"
                step="500"
                required
                value={securityDeposit}
                readOnly aria-describedby="deposit-guidance"
                className="w-full bg-[#0d1017] text-white border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-white focus:ring-1 focus:ring-white/20"
              />
            </div>

            <p id="deposit-guidance" className="text-sm text-amber-200">New security deposits are unavailable in the ordinary residential workflow. Historical listing deposits are not copied into new agreements.</p>
            <div><label htmlFor="advance-rent" className="block text-sm text-slate-300 mb-2">Advance rent (BDT)</label><input id="advance-rent" name="advance_rent" type="number" min="0" max={rent||0} step="0.01" value={advanceRent} onChange={e=>setAdvanceRent(e.target.value)} className="w-full bg-[#0d1017] text-white border border-slate-700 rounded-lg px-3 py-3" aria-describedby="advance-guidance"/><p id="advance-guidance" className="text-sm text-slate-300 mt-2">Maximum one month's rent. More requires prior Rent Controller approval under Section 10; exceptional collection is unsupported here.</p></div>
            <div>
              <label
                htmlFor="contract-electricity"
                className="block text-xs uppercase font-medium text-slate-300 mb-1"
              >
                Electricity Bill (BDT) *
              </label>
              <input
                id="contract-electricity"
                type="number"
                min="0"
                required
                value={electricityBill}
                onChange={(e) => setElectricityBill(e.target.value)}
                className="w-full bg-[#0d1017] text-white border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-white focus:ring-1 focus:ring-white/20"
              />
            </div>

            <div>
              <label
                htmlFor="contract-water"
                className="block text-xs uppercase font-medium text-slate-300 mb-1"
              >
                Water Bill (BDT) *
              </label>
              <input
                id="contract-water"
                type="number"
                min="0"
                required
                value={waterBill}
                onChange={(e) => setWaterBill(e.target.value)}
                className="w-full bg-[#0d1017] text-white border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-white focus:ring-1 focus:ring-white/20"
              />
            </div>

            <div>
              <label
                htmlFor="contract-service"
                className="block text-xs uppercase font-medium text-slate-300 mb-1"
              >
                Service Charge (BDT) *
              </label>
              <input
                id="contract-service"
                type="number"
                min="0"
                required
                value={serviceCharge}
                onChange={(e) => setServiceCharge(e.target.value)}
                className="w-full bg-[#0d1017] text-white border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-white focus:ring-1 focus:ring-white/20"
              />
            </div>

            <div>
              <label
                htmlFor="contract-due-date"
                className="block text-xs uppercase font-medium text-slate-300 mb-1"
              >
                Monthly Due Date (1 - 28) *
              </label>
              <input
                id="contract-due-date"
                type="number"
                min="1"
                max="28"
                required
                value={monthlyDueDate}
                onChange={(e) => setMonthlyDueDate(e.target.value)}
                className="w-full bg-[#0d1017] text-white border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-white focus:ring-1 focus:ring-white/20"
              />
            </div>
          </div>

          <div className="flex items-center gap-2 pt-2">
            <input
              id="contract-pet-allowed"
              type="checkbox"
              checked={petAllowed}
              onChange={(e) => setPetAllowed(e.target.checked)}
              className="w-4 h-4 rounded text-black accent-[#d4b068] cursor-pointer"
            />
            <label htmlFor="contract-pet-allowed" className="text-sm text-slate-300 cursor-pointer">
              Pets Allowed in this Lease
            </label>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="mt-4 w-full bg-white text-slate-900 font-semibold py-3 px-6 rounded-xl hover:bg-slate-200 transition disabled:opacity-50 cursor-pointer text-sm shadow-md"
          >
            {loading ? "Proposing Contract..." : "Propose Digital Lease Agreement"}
          </button>
        </form>
      </div>
    </div>
  );
}
