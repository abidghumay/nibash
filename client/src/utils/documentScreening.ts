export function screeningLabel(status?: string | null) {
  switch (status) {
    case "passed": return "Screening passed";
    case "flagged": return "Needs review";
    case "auto_rejected": return "Screening failed";
    case "failed": return "Screening unavailable — manual review needed";
    default: return "Screening pending";
  }
}
