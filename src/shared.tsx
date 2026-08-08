import type { ReactNode } from "react";

const engineSite = "https://game-engine.subzerodev.com/";
const engineDocs = "https://game-engine.subzerodev.com/docs/";
const repository = "https://github.com/The-Running-Dev/SubZeroDev.Adventures";

export function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

export function SiteHeader() {
  return (
    <header className="site-header">
      <a className="wordmark" href="/" aria-label="SubZeroDev Adventures home">
        <span>SUBZERODEV</span>
        <strong>ADVENTURES</strong>
      </a>
      <nav aria-label="Explore the project">
        <ExternalLink href={engineSite}>Engine</ExternalLink>
        <ExternalLink href={engineDocs}>Documentation</ExternalLink>
        <ExternalLink href={repository}>GitHub</ExternalLink>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer>
      <p>Started because someone asked an LLM the wrong question.</p>
      <p>Built because nobody stopped asking better ones.</p>
      <strong>Well... why not?</strong>
      <small>
        No inventory systems were harmed during the making of these stories.
        Probably.
      </small>
    </footer>
  );
}
