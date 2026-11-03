import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import policyText from "../content/rental-protection-policy.md?raw";
import "../styles/rental-policy.css";

// Only the authored text and HTTPS links are rendered; raw HTML is never interpreted.
function inlineText(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const links = /\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g;
  let position = 0;
  for (const match of text.matchAll(links)) {
    parts.push(text.slice(position, match.index));
    parts.push(
      <a
        key={match.index}
        href={match[2]}
        target="_blank"
        rel="noopener noreferrer"
      >
        {match[1]}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>,
    );
    position = match.index! + match[0].length;
  }
  parts.push(text.slice(position));
  return parts;
}

const [introduction, ...content] = policyText.trim().split(/\n(?=## )/);
const [title, ...introParagraphs] = introduction.split(/\n\s*\n/);
const sections = content.map((section, index) => {
  const [heading, ...paragraphs] = section.trim().split(/\n\s*\n/);
  return {
    id: `policy-section-${index + 1}`,
    title: heading.replace(/^## /, ""),
    paragraphs,
  };
});

function downloadPolicy() {
  const url = URL.createObjectURL(
    new Blob([policyText], { type: "text/markdown;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "Nibash-Rental-Protection-Policy-v1.md";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function RentalPolicyPage() {
  return (
    <div className="rental-policy">
      <header className="rental-policy-header">
        <p className="rental-policy-eyebrow">NIBASH / POLICIES</p>
        <h1>{title.replace(/^# /, "")}</h1>
        {introParagraphs.map((paragraph, index) => (
          <p key={index}>{inlineText(paragraph)}</p>
        ))}
        <div className="rental-policy-actions">
          <button type="button" onClick={() => window.print()}>
            Print policy
          </button>
          <button type="button" onClick={downloadPolicy}>
            Download text
          </button>
          <Link to="/register">Return to registration</Link>
        </div>
      </header>
      <div className="rental-policy-layout">
        <nav aria-label="Policy contents" className="rental-policy-contents">
          <h2>On this page</h2>
          <ol>
            {sections.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`}>
                  {section.title.replace(/^\d+\. /, "")}
                </a>
              </li>
            ))}
          </ol>
        </nav>
        <article aria-label="Rental Protection and Records Policy">
          {sections.map((section) => (
            <section key={section.id} aria-labelledby={section.id}>
              <h2 id={section.id}>{section.title}</h2>
              {section.paragraphs.map((paragraph, index) => (
                <p key={index}>{inlineText(paragraph.replace(/\n/g, " "))}</p>
              ))}
            </section>
          ))}
        </article>
      </div>
    </div>
  );
}
