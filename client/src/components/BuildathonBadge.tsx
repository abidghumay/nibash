import sticker from "../assets/buildathon-2026-sticker.jpg";

export function BuildathonBadge({ className = "" }: { className?: string }) {
  return (
    <img
      src={sticker}
      alt="Built for Ostad presents YUNet AIgnite Buildathon 2026 — National AI Hackathon for B2C Solutions"
      width={1280}
      height={454}
      className={`h-auto max-w-full rounded-lg ${className}`}
    />
  );
}
