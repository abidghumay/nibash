// Product service envelope, not an administrative Dhaka boundary. Neighborhood
// centers label supported points; the legacy 500m radii do not define coverage.
export const DHAKA_SERVICE_BOUNDS = {
  south: 23.65, north: 23.95, west: 90.30, east: 90.55,
} as const;

export function isSupportedLocation(latitude: number, longitude: number): boolean {
  const { south, north, west, east } = DHAKA_SERVICE_BOUNDS;
  return Number.isFinite(latitude) && Number.isFinite(longitude) &&
    latitude >= south && latitude <= north && longitude >= west && longitude <= east;
}
