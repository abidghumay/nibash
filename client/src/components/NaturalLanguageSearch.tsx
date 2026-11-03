import { useEffect, useRef, useState } from 'react';
import { apiClient } from '../api/client';
import { useAreas } from '../context/AreaContext';
import type { NaturalSearchState, SearchFilters, SearchInterpretation } from '../utils/naturalLanguageSearch';

const control = 'w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-slate-300';
const numberFields = [
  ['minRent', 'Minimum rent (৳)'], ['maxRent', 'Maximum rent (৳)'],
  ['bedrooms', 'Exact bedrooms'], ['minBedrooms', 'Minimum bedrooms'],
  ['bathrooms', 'Bathrooms'], ['floor', 'Floor (0 = ground)'],
] as const;

export function NaturalLanguageSearch({ state, onChange, manualKey, amenityNames, onOrdinarySearch }: {
  state: NaturalSearchState;
  onChange: (state: NaturalSearchState) => void;
  manualKey: string;
  amenityNames: string[];
  onOrdinarySearch: (query: string) => void;
}) {
  const { areas, loading: areasLoading, error: areasError } = useAreas();
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const requestVersion = useRef(0);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const pending = useRef(false);

  useEffect(() => {
    const versionRef = requestVersion;
    requestVersion.current++;
    if (pending.current) {
      pending.current = false;
      onChange({ phase: 'idle', interpretation: null });
      setError('Manual filters changed. Submit your description again to interpret it.');
    }
    return () => { versionRef.current++; };
  }, [manualKey, onChange]);

  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => {
    if (state.phase !== 'interpreting' && pending.current) {
      requestVersion.current++;
      pending.current = false;
    }
  }, [state.phase]);

  const interpret = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!query.trim()) return;
    const version = ++requestVersion.current;
    pending.current = true;
    setError('');
    onChange({ phase: 'interpreting', interpretation: null });
    try {
      const interpretation = await apiClient.post<SearchInterpretation>('/listings/search/interpret', { query: query.trim() });
      if (version !== requestVersion.current) return;
      pending.current = false;
      onChange({ phase: 'ready', interpretation });
    } catch (err) {
      if (version !== requestVersion.current) return;
      pending.current = false;
      setError(err instanceof Error ? err.message : 'Could not interpret your description. Try again or use ordinary search.');
      onChange({ phase: 'error', interpretation: null });
    }
  };

  const interpretation = state.interpretation;
  const editFilter = (key: keyof SearchFilters, value: SearchFilters[keyof SearchFilters]) => {
    if (!interpretation) return;
    const filters = { ...interpretation.filters, [key]: value };
    if (key === 'areaId') delete filters.areaName;
    if (key === 'areaName') delete filters.areaId;
    onChange({ phase: 'ready', interpretation: { ...interpretation, filters } });
  };

  return (
    <section className="mb-4 rounded-xl border border-slate-700 bg-[#12151c] p-4 sm:p-5" aria-label="Natural language apartment search">
      <form onSubmit={interpret} className="space-y-3">
        <label htmlFor="natural-query" className="block text-sm font-medium text-white">Describe your next apartment</label>
        <p id="natural-help" className="text-sm text-slate-400">Use বাংলা, English, or Banglish. Requirements below stay editable; manual filters also apply.</p>
        <textarea id="natural-query" value={query} rows={2} maxLength={600} required aria-describedby="natural-help" placeholder="ধানমন্ডিতে ৩ বেডের বাসা, ৩০ হাজারের মধ্যে, লিফট লাগবে" className={control}
          onChange={(event) => {
            requestVersion.current++;
            pending.current = false;
            setQuery(event.target.value);
            setError('');
            onChange({ phase: 'idle', interpretation: null });
          }} />
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={state.phase === 'interpreting' || !query.trim()} className="min-h-11 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50">{state.phase === 'interpreting' ? 'Understanding your requirements…' : 'Find matching apartments'}</button>
          <button type="button" onClick={() => onOrdinarySearch(query)} className="min-h-11 text-sm text-slate-300 underline underline-offset-4">Use ordinary search</button>
        </div>
        {error && <p ref={errorRef} tabIndex={-1} role="alert" className="text-sm text-amber-200">{error}</p>}
      </form>
      {state.phase === 'interpreting' && <p role="status" className="mt-3 text-sm text-slate-300">Interpreting once for this search. Listing results will follow.</p>}
      {interpretation?.status === 'fallback' && <p role="alert" className="mt-4 rounded-lg border border-amber-700 p-3 text-sm text-amber-200">We could not reliably understand these requirements. No matching results are shown. Try a clearer description or explicitly choose “Use ordinary search”.</p>}
      {interpretation?.warnings.map((warning, index) => <p key={index} role="status" className="mt-3 text-sm text-amber-200">{warning}</p>)}
      {interpretation?.status === 'interpreted' && (
        <div className="mt-5 space-y-4 border-t border-slate-700 pt-4">
          <p className="text-sm font-semibold text-white">Interpreted requirements <span className="font-normal text-slate-400">— edit or clear a field to change it</span></p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="space-y-1 text-sm text-slate-300">Area
              <select disabled={areasLoading || Boolean(areasError)} className={control} value={interpretation.filters.areaName ?? (interpretation.filters.areaId ? `id:${interpretation.filters.areaId}` : '')} onChange={(event) => editFilter('areaName', event.target.value || undefined)}>
                <option value="">{areasLoading ? 'Loading areas…' : areasError ? 'Areas unavailable' : 'Any area'}</option>
                {interpretation.filters.areaName && !areas.some((area) => area.name === interpretation.filters.areaName) && <option value={interpretation.filters.areaName}>{interpretation.filters.areaName}</option>}
                {!interpretation.filters.areaName && interpretation.filters.areaId && <option value={`id:${interpretation.filters.areaId}`}>Area #{interpretation.filters.areaId}</option>}
                {areas.map((area) => <option key={area.name} value={area.name}>{area.name}</option>)}
              </select>
            </label>
            {numberFields.map(([key, label]) => <label key={key} className="space-y-1 text-sm text-slate-300">{label}
              <input className={control} type="number" min={0} step={1} value={interpretation.filters[key] ?? ''} onChange={(event) => editFilter(key, event.target.value === '' ? undefined : Number(event.target.value))} />
            </label>)}
            <label className="space-y-1 text-sm text-slate-300">Pets
              <select className={control} value={interpretation.filters.pets === undefined ? '' : String(interpretation.filters.pets)} onChange={(event) => editFilter('pets', event.target.value === '' ? undefined : event.target.value === 'true')}>
                <option value="">Any pet policy</option><option value="true">Pets allowed</option><option value="false">No pets</option>
              </select>
            </label>
            <label className="space-y-1 text-sm text-slate-300">Required amenities (comma separated)
              <input className={control} value={(interpretation.filters.amenityNames || []).join(',')} onChange={(event) => editFilter('amenityNames', event.target.value.split(','))} />
              {amenityNames.length > 0 && <span className="block text-xs text-slate-400">Available: {amenityNames.join(', ')}</span>}
              {amenityNames.length > 0 && (interpretation.filters.amenityNames || []).some((name) => name.trim() && !amenityNames.some((available) => available.toLowerCase() === name.trim().toLowerCase())) && <span role="status" className="block text-xs text-amber-200">An entered amenity is unavailable in the catalog. It may return no matches; choose an available amenity or remove it.</span>}
            </label>
            <label className="space-y-1 text-sm text-slate-300">Required keywords
              <input className={control} value={interpretation.filters.keywords ?? ''} onChange={(event) => editFilter('keywords', event.target.value || undefined)} />
            </label>
          </div>
          {interpretation.unsupported.length > 0 && <div className="space-y-2 rounded-lg border border-amber-700 p-3 text-sm text-amber-100" role="alert">
            <p>Some requirements cannot be checked. Mandatory requirements block results until you explicitly remove them.</p>
            {interpretation.unsupported.map((item, index) => <div key={index} className="flex flex-wrap items-center justify-between gap-2">
              <span>{item.mandatory ? 'Required' : 'Optional'}: {item.requirement} — {item.reason}</span>
              <button type="button" className="min-h-11 underline underline-offset-4" onClick={() => onChange({ phase: 'ready', interpretation: { ...interpretation, unsupported: interpretation.unsupported.filter((_, itemIndex) => itemIndex !== index) } })}>Remove requirement: {item.requirement}</button>
            </div>)}
          </div>}
          {interpretation.preferences.length > 0 && <div className="text-sm text-slate-300"><p className="font-medium">Preferences (informational; not applied as filters)</p><ul className="mt-1 list-inside list-disc">{interpretation.preferences.map((preference, index) => <li key={index}>{preference}</li>)}</ul></div>}
        </div>
      )}
    </section>
  );
}
