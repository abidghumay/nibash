export function setOptions() {}
export function importLibrary(name: string) {
  return (globalThis as unknown as { mapsTestLibrary: (name: string) => Promise<unknown> }).mapsTestLibrary(name);
}
