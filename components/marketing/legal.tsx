// Shared chrome and typography for the legal pages.
//
// WHY A WRAPPER. /legal/terms and /legal/privacy have to agree on the entity
// name, the contact address and the "last updated" convention. Three copies of
// a company name is how a policy ends up naming a business that doesn't exist.
//
// ------------------------------------------------------------------------
// BEFORE THESE GO LIVE — these are drafts written from what the system
// ACTUALLY does, not boilerplate, but they are not legal advice and nobody
// with a licence has read them. Confirm at minimum:
//
//   1. LEGAL_ENTITY and LEGAL_ADDRESS below — the registered name and address.
//   2. GOVERNING_LAW — set to where the business is actually registered.
//   3. CALL DISCLOSURE. California is a two-party consent state and several
//      others are too. Conversations are transcribed and stored, so the AGENT
//      should say so at the start of a call, and the obligation to disclose
//      falls on the client whose line it is. This is the highest-risk item on
//      the page and it is a product change, not just wording — see the privacy
//      policy's "Your Responsibilities" section.
//   4. The liability cap and the indemnity — the two clauses a lawyer will
//      actually change.
// ------------------------------------------------------------------------

import { MarketingShell } from "@/components/marketing/shell";

export const LEGAL_ENTITY = "LumiLink";
export const LEGAL_ADDRESS = "Los Angeles, California, United States";
export const LEGAL_EMAIL = "support@lumilinkhub.com";
export const GOVERNING_LAW = "the State of California, United States";

/** One date for both documents, so they can't drift apart. */
export const LEGAL_LAST_UPDATED = "13 August 2026";

export function LegalPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: React.ReactNode;
}) {
  return (
    <MarketingShell>
      <div className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-4xl font-semibold tracking-tight text-gray-900">
          {title}
        </h1>
        <p className="mt-2 text-sm text-gray-500">
          Last updated {LEGAL_LAST_UPDATED}
        </p>
        <p className="mt-6 text-lg leading-relaxed text-gray-600">{intro}</p>

        <div className="mt-12 space-y-10">{children}</div>

        <div className="mt-16 border-t border-gray-200 pt-8 text-sm text-gray-500">
          <p>
            Questions about this page? Email{" "}
            <a
              href={`mailto:${LEGAL_EMAIL}`}
              className="underline hover:text-gray-900"
            >
              {LEGAL_EMAIL}
            </a>
            .
          </p>
        </div>
      </div>
    </MarketingShell>
  );
}

/** A numbered clause. Plain language first, exceptions second. */
export function Clause({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="text-xl font-semibold text-gray-900">{heading}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-gray-600">
        {children}
      </div>
    </section>
  );
}
