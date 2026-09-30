// "/legal/privacy" — what we hold, why, and who else touches it.
//
// WRITTEN FROM THE ACTUAL DATA FLOWS, not a template. Every sub-processor named
// below is one the system genuinely calls, and every category of data listed is
// one that genuinely lands in a table. If a flow changes, this page changes —
// a privacy policy describing a system you no longer run is worse than none.

import type { Metadata } from "next";
import Link from "next/link";
import {
  Clause,
  CONTACT_FALLBACK,
  LEGAL_EMAIL,
  LEGAL_ENTITY,
  LegalPage,
} from "@/components/marketing/legal";

export const metadata: Metadata = {
  title: "Privacy Policy | LumiLink",
  description:
    "What LumiLink collects when the agent answers a call, how long we keep it, who processes it, and what you're responsible for telling your callers.",
  alternates: { canonical: "/legal/privacy" },
};

/**
 * Every third party that genuinely processes customer data. Keep this list
 * honest — naming a processor you don't use is harmless, omitting one you do
 * is the failure that matters.
 */
const SUBPROCESSORS = [
  ["Supabase", "Database, authentication and file storage"],
  ["ElevenLabs", "Speech recognition and the agent's voice"],
  ["Twilio", "Telephone numbers and call connectivity"],
  ["Anthropic", "The language model that decides what the agent says"],
  ["Stripe", "Payments and subscriptions"],
  ["Resend", "Transactional email, such as sign-in and confirmation messages"],
  ["Railway", "Application hosting"],
];

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      intro={`This explains what ${LEGAL_ENTITY} collects, why, and who else is involved. There are two different relationships here and they matter: the information you give us about your business, and the information your customers give the agent when they call you.`}
    >
      <Clause heading="Two Roles, Two Sets Of Data">
        <p>
          <strong>Your data.</strong>{" "}
          When you sign up we hold your name,
          business name, email address and billing details, plus everything you
          configure — hours, services, prices, policies and how the agent should
          sound.
        </p>
        <p>
          <strong>Your customers&rsquo; data.</strong>{" "}
          When someone calls your
          line, we process their information <em>on your behalf</em>. You decide
          what your agent does and what it knows; we operate it for you. In data
          protection terms you are the controller and we are the processor.
        </p>
      </Clause>

      <Clause heading="What The Agent Collects On A Call">
        <ul className="ml-5 list-disc space-y-1">
          <li>the caller&rsquo;s phone number, and their name if they give it;</li>
          <li>
            a written transcript of the conversation, and how long the call
            lasted;
          </li>
          <li>
            anything the caller provides so the agent can help — an order
            number, an address, an appointment time, or an email address or ZIP
            code used to confirm who they are;
          </li>
          <li>
            for online stores, order details read from your store so the agent
            can answer questions about them.
          </li>
        </ul>
        <p>
          Call audio is processed by our voice provider to turn speech into text
          and text into speech. What we store is the transcript.
        </p>
      </Clause>

      <Clause heading="What We Use It For">
        <p>
          To operate your agent, show you your conversations, book appointments,
          look up orders, create callback tickets, meter your usage against your
          plan, and support and improve the service.
        </p>
        <p>
          <strong>We do not sell personal information.</strong>{" "}
          We do not use one
          customer&rsquo;s business content or call data to serve another
          customer.
        </p>
      </Clause>

      <Clause heading="Your Responsibilities To Your Callers">
        <p>
          This is the part most easily overlooked, and it is yours rather than
          ours.
        </p>
        <p>
          Calls to your line are answered by an automated system and are
          transcribed and stored. Some places — including California and several
          other US states — require everyone on a call to be told when it is
          recorded, and rules on disclosing automated systems vary by
          jurisdiction. <strong>You are responsible for meeting the
          requirements that apply to your business and your callers</strong>,
          including any notice on your website or spoken at the start of a call.
        </p>
        <p>
          We can configure your agent to say so at the beginning of every call.
          If you want that, ask us and we will set it up.
        </p>
      </Clause>

      {/* Google OAuth verification reads this clause. It covers only the
          scopes the app requests today (lib/google-oauth.ts). When the
          Business Profile flow ships (plan.md Phase 4), add what it reads and
          writes here BEFORE requesting business.manage in production. */}
      <Clause heading="Information From Your Google Account">
        <p>
          If you connect your Google account in Settings, we ask Google for two
          things: your Google account&rsquo;s email address, so we can show you
          which account is connected, and <strong>read-only</strong> access to
          Google Search Console for your website.
        </p>
        <p>
          We use Search Console for one purpose: checking whether Google has
          indexed the pages on your website and, if it hasn&rsquo;t, why not.
          Problems we find appear as findings in your dashboard. We cannot
          change anything in your Search Console account.
        </p>
        <p>
          Your Google access token is stored in a dedicated secrets vault,
          encrypted, and used only by our own systems to run those checks.
          Information we receive from Google is:
        </p>
        <ul className="ml-5 list-disc space-y-1">
          <li>never sold, and never used for advertising;</li>
          <li>never used to train AI models, and never sent to one;</li>
          <li>
            never shared with anyone else, except as needed to run the features
            you see, to comply with the law, or as part of a merger or
            acquisition that we would tell you about;
          </li>
          <li>
            not read by our staff unless you ask us to, or unless it&rsquo;s
            needed for security or to meet a legal obligation.
          </li>
        </ul>
        <p>
          You can disconnect Google at any time in Settings. We revoke our
          access with Google and delete the stored token. You can also remove
          LumiLink from your{" "}
          <a
            href="https://myaccount.google.com/permissions"
            className="underline hover:text-gray-900"
          >
            Google account permissions
          </a>
          . Findings we already produced stay in your dashboard until you ask
          us to delete them or close your account.
        </p>
        <p>
          LumiLink&rsquo;s use and transfer of information received from Google
          APIs will adhere to the{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            className="underline hover:text-gray-900"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
      </Clause>

      <Clause heading="Who Else Processes It">
        <p>
          We use these providers to run the service. Each has access only to what
          it needs to do its job.
        </p>
        <div className="mt-4 overflow-hidden rounded-lg border border-gray-200">
          <table className="w-full text-left text-sm">
            <tbody className="divide-y divide-gray-200">
              {SUBPROCESSORS.map(([name, role]) => (
                <tr key={name}>
                  <th className="w-1/3 bg-gray-50 px-4 py-2 font-medium text-gray-900">
                    {name}
                  </th>
                  <td className="px-4 py-2 text-gray-600">{role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          If you connect your online store, we hold read-only credentials to it.
          The agent looks orders up; it never edits, cancels or refunds them.
        </p>
      </Clause>

      <Clause heading="How Long We Keep It">
        <p>
          Conversations, transcripts and the records built from them are kept for
          as long as your account is active, because they are what your dashboard
          shows you.
        </p>
        <p>
          If you cancel, tell us and we will delete your business data and your
          call records. We keep the minimum needed for legal and accounting
          purposes, such as invoices.
        </p>
        <p>
          If one of your customers asks you to delete their information, contact
          us and we will remove it from your workspace.
        </p>
      </Clause>

      <Clause heading="Security">
        <p>
          Data is encrypted in transit and at rest by our infrastructure
          providers. Each customer&rsquo;s data is isolated at the database
          level, so one workspace cannot read another&rsquo;s. Store credentials
          are held in a dedicated secrets vault rather than in application
          configuration.
        </p>
        <p>
          No system is perfectly secure. If a breach affects your data we will
          tell you.
        </p>
      </Clause>

      <Clause heading="Your Rights">
        <p>
          Depending on where you live you may have the right to access, correct,
          export or delete your personal information, and to object to some
          processing.{" "}
          {LEGAL_EMAIL ? (
            <>
              Email{" "}
              <a
                href={`mailto:${LEGAL_EMAIL}`}
                className="underline hover:text-gray-900"
              >
                {LEGAL_EMAIL}
              </a>{" "}
              and we will help.
            </>
          ) : (
            <>{CONTACT_FALLBACK} We will help.</>
          )}
        </p>
        <p>
          If your request is about a call you made to a business that uses
          LumiLink, contact that business first — the data is theirs, and we act
          on their instructions.
        </p>
      </Clause>

      <Clause heading="Changes">
        <p>
          We will update this page when the service changes. The date at the top
          shows when it last changed. See also our{" "}
          <Link href="/legal/terms" className="underline hover:text-gray-900">
            terms of service
          </Link>
          .
        </p>
      </Clause>
    </LegalPage>
  );
}
