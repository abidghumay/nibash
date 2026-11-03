import { useEffect, useRef, useState } from "react";
import { setOptions, importLibrary } from "@googlemaps/js-api-loader";

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string;
const MAP_ID = import.meta.env.VITE_GOOGLE_MAPS_MAP_ID as string;

let configured = false;
function ensureConfigured() {
  if (!configured) {
    setOptions({ key: GOOGLE_MAPS_API_KEY, v: "weekly" });
    configured = true;
  }
}

interface LocationPickerProps {
  latitude: number;
  longitude: number;
  onChange: (lat: number, lng: number) => void;
}

export function LocationPicker({
  latitude,
  longitude,
  onChange,
}: LocationPickerProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const autocompleteContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const markerInstanceRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const latestRef = useRef({ latitude, longitude, onChange });
  const selectionVersion = useRef(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { latestRef.current = { latitude, longitude, onChange }; });

  useEffect(() => {
    selectionVersion.current++;
    const position = { lat: latitude, lng: longitude };
    if (markerInstanceRef.current) markerInstanceRef.current.position = position;
    mapInstanceRef.current?.panTo(position);
  }, [latitude, longitude]);

  useEffect(() => {
    let cancelled = false;
    let autocomplete: google.maps.places.PlaceAutocompleteElement | null = null;
    let removeAutocompleteListener: (() => void) | undefined;
    ensureConfigured();

    (async () => {
      try {
        const { Map } = (await importLibrary(
          "maps",
        )) as google.maps.MapsLibrary;
        const { AdvancedMarkerElement } = (await importLibrary(
          "marker",
        )) as google.maps.MarkerLibrary;
        const { PlaceAutocompleteElement } = (await importLibrary(
          "places",
        )) as google.maps.PlacesLibrary;
        if (cancelled || !mapRef.current || !autocompleteContainerRef.current)
          return;

        const map = new Map(mapRef.current, {
          center: { lat: latestRef.current.latitude, lng: latestRef.current.longitude },
          zoom: 15,
          mapId: MAP_ID,
          colorScheme: google.maps.ColorScheme.DARK,
          renderingType: google.maps.RenderingType.VECTOR,
        });

        const marker = new AdvancedMarkerElement({
          position: { lat: latestRef.current.latitude, lng: latestRef.current.longitude },
          map,
          gmpDraggable: true,
        });
        mapInstanceRef.current = map;
        markerInstanceRef.current = marker;

        marker.addListener("dragend", () => {
          const pos = marker.position;
          if (pos) {
            selectionVersion.current++;
            setError(null);
            const lat = typeof pos.lat === "function" ? pos.lat() : Number(pos.lat);
            const lng = typeof pos.lng === "function" ? pos.lng() : Number(pos.lng);
            latestRef.current.onChange(lat, lng);
          }
        });

        map.addListener("click", (e: google.maps.MapMouseEvent) => {
          if (!e.latLng) return;
          selectionVersion.current++;
          setError(null);
          marker.position = e.latLng;
          latestRef.current.onChange(e.latLng.lat(), e.latLng.lng());
        });

        autocomplete = new PlaceAutocompleteElement({
          includedRegionCodes: ["bd"],
        });
        autocompleteContainerRef.current.appendChild(autocomplete);

        const handleSelect = async (event: Event) => {
          const version = ++selectionVersion.current;
          setError(null);
          try {
            const place = (event as google.maps.places.PlacePredictionSelectEvent).placePrediction.toPlace();
            await place.fetchFields({ fields: ["location"] });
            const loc = place.location;
            if (cancelled || version !== selectionVersion.current || !loc) return;
            map.panTo(loc);
            map.setZoom(16);
            marker.position = loc;
            latestRef.current.onChange(loc.lat(), loc.lng());
          } catch {
            if (!cancelled && version === selectionVersion.current) setError("Could not find that location. Try again or place the pin on the map.");
          }
        };
        autocomplete.addEventListener("gmp-select", handleSelect);
        removeAutocompleteListener = () => autocomplete?.removeEventListener("gmp-select", handleSelect);

        setLoaded(true);
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setError(
            "Failed to load Google Maps. Check your API key / referrer restrictions.",
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      removeAutocompleteListener?.();
      autocomplete?.remove();
      if (markerInstanceRef.current) {
        google.maps.event.clearInstanceListeners(markerInstanceRef.current);
        markerInstanceRef.current.map = null;
        markerInstanceRef.current = null;
      }
      if (mapInstanceRef.current) {
        google.maps.event.clearInstanceListeners(mapInstanceRef.current);
        mapInstanceRef.current = null;
      }
    };
  }, []);

  return (
    // TODO: Style the autocomplete input to match the rest of the app
    <div className="flex flex-col gap-2">
      <div ref={autocompleteContainerRef} className="w-full" />
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div
        ref={mapRef}
        className="w-full h-72 rounded-lg border border-slate-700 overflow-hidden"
      />
      {!loaded && !error && (
        <p className="text-xs text-slate-400">Loading map...</p>
      )}
      <p className="text-[11px] text-slate-500">
        Click the map or drag the pin to set the exact location. Listings are supported in the Dhaka service area. Lat:{" "}
        {latitude.toFixed(5)}, Lng: {longitude.toFixed(5)}
      </p>
    </div>
  );
}
