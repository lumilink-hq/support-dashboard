// "/legal/terms" — the agreement a customer accepts by subscribing.
//
// Written from what the product ACTUALLY does. Where a clause depends on
// behaviour that could change, it names the behaviour rather than a number, so
// changing a cap doesn't silently make this page a lie.

import type { Metadata } from "next";
import Link from "next/link";
import {
  Clause,
  CONTACT_FALLBACK,
  GOVERNING_LAW,
  LEGAL_EMAIL,
  LEGAL_ENTITY,
  LegalPage,
} from "@/components/marketing/legal";
import { STARTER_PLAN } from "@/lib/entitlements";

export const metadata: Metadata = {
  title: "Terms Of Service | LumiLink",
  description:
    "The terms you agree to when you subscribe to LumiLink: what we provide, what you're responsible for, billing, cancellation and liability.",
  alternates: { canonical: "/legal/terms" },
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms Of Service"
      intro={`These terms apply when you use ${LEGAL_ENTITY}. By creating an account or subscribing to a plan, you agree to them. We've written them in plain language — where something limits what you can expect from us, it says so directly rather than hiding in a long sentence.`}
    >
      <Clause heading="1. What We Provide">
        <p>
          {LEGAL_ENTITY} provides an AI phone agent that answers calls on a
          number we provision for you, using information you give us about your
          business. Depending on your configuration it can book appointments,
          answer questions about your services or orders, and take details for a
          callback when it can&rsquo;t finish the conversation itself.
        </p>
        <p>
          We set the service up for you at no charge. Setup includes provisioning
          your phone number, loading your business information, configuring the
          agent and testing it before it goes live.
        </p>
      </Clause>

      <Clause heading="2. The Agent Is Software, And It Can Be Wrong">
        <p>
          The agent answers from the information you provide and from your
          publicly available business content. It can misunderstand a caller,
          mishear a number, or give an answer that is out of date because the
          underlying information is out of date.
        </p>
        <p>
          <strong>You are responsible for the accuracy of what you give us</strong>{" "}
          — your prices, hours, services, policies and any other business
          information. We build the agent around that information; we do not
          verify it.
        </p>
        <p>
          <strong>Tell us when something is wrong.</strong> You can read every
          conversation in your dashboard. If the agent is saying something
          incorrect, let us know and we will correct it. We can only fix what we
          know about, and we are not liable for a repeated error you were able to
          see and did not report.
        </p>
        <p>
          The agent will not invent prices, delivery dates or commitments you
          haven&rsquo;t given it. When it doesn&rsquo;t know something, it says
          so and hands the conversation to you.
        </p>
      </Clause>

      <Clause heading="3. Your Plan And What's Included">
        <p>
          Each plan includes a monthly allowance of AI call time, at least one
          phone number, and the platform care hours described on the plan. Plans
          and current allowances are listed on our{" "}
          <Link href="/plans" className="underline hover:text-gray-900">
            plans page
          </Link>
          .
        </p>
        <p>
          <strong>Your allowance is a cap, not a meter.</strong> We do not bill
          you for going over it. If you reach your allowance, calls beyond it are
          not answered by the agent until your next billing period, or until you
          move to a larger plan. We will always rather tell you to upgrade than
          send you a bill you didn&rsquo;t agree to.
        </p>
        <p>
          Individual AI calls are limited to about{" "}
          {STARTER_PLAN.maxCallMinutes} minutes. Near that limit the agent closes
          the conversation and offers a transfer or a callback rather than being
          cut off.
        </p>
      </Clause>

      <Clause heading="4. Billing">
        <p>
          Plans are billed monthly in advance through Stripe. Add-ons are billed
          on the same subscription. Prices are in US dollars and exclude any tax
          that applies to you.
        </p>
        <p>
          If a payment fails we may suspend the service after giving you notice.
          A suspended line does not answer calls.
        </p>
      </Clause>

      <Clause heading="5. Cancel Anytime">
        <p>
          <strong>You can cancel at any time</strong> from your dashboard.{" "}
          {LEGAL_EMAIL ? (
            <>
              You can also email{" "}
              <a
                href={`mailto:${LEGAL_EMAIL}`}
                className="underline hover:text-gray-900"
              >
                {LEGAL_EMAIL}
              </a>
              .
            </>
          ) : (
            CONTACT_FALLBACK
          )}{" "}
          Your service continues to the end of the period you have paid for and
          is not renewed.
        </p>
        <p>
          <strong>We don&rsquo;t pro-rate the month you&rsquo;re already in</strong>{" "}
          and we don&rsquo;t refund partial months. There is no cancellation fee,
          no minimum term and no retention process.
        </p>
        <p>
          If something has gone genuinely wrong on our side, talk to us. We would
          rather resolve it than argue about a clause.
        </p>
      </Clause>

      <Clause heading="6. Your Responsibilities">
        <p>You agree that you will:</p>
        <ul className="ml-5 list-disc space-y-1">
          <li>
            use the service lawfully, and only for a business you own or are
            authorised to represent;
          </li>
          <li>
            give us accurate business information, and keep it up to date;
          </li>
          <li>
            comply with the laws that apply to calls made to and from your line,
            including any obligation to tell callers that a call is handled by an
            automated system or is recorded or transcribed &mdash; see our{" "}
            <Link
              href="/legal/privacy"
              className="underline hover:text-gray-900"
            >
              privacy policy
            </Link>
            ;
          </li>
          <li>
            not use the agent to make unsolicited marketing calls, or for any
            unlawful, deceptive or harassing purpose;
          </li>
          <li>keep your account credentials secure.</li>
        </ul>
      </Clause>

      <Clause heading="7. Suspension">
        <p>
          We may suspend or end an account that is being used unlawfully, that is
          creating risk for us or for other customers, or that is significantly
          overdue on payment. Where it is reasonable to do so, we will tell you
          first and give you a chance to put it right.
        </p>
      </Clause>

      <Clause heading="8. Ownership">
        <p>
          You keep ownership of your business information and of the
          conversations your customers have with your agent. We own the platform,
          the software and everything we build to run it.
        </p>
        <p>
          You grant us permission to use your information to operate the service
          for you. We do not sell it, and we do not use one customer&rsquo;s
          business content to serve another.
        </p>
      </Clause>

      <Clause heading="9. Availability">
        <p>
          We aim to keep the service running continuously, but we do not offer a
          guaranteed uptime commitment on our standard plans. The service depends
          on third parties &mdash; telephony, voice and hosting providers &mdash;
          and an outage at one of them can interrupt it.
        </p>
      </Clause>

      <Clause heading="10. Liability">
        <p>
          To the extent the law allows, {LEGAL_ENTITY} is not liable for lost
          profits, lost business, lost data, or any indirect or consequential
          loss.
        </p>
        <p>
          Our total liability to you for any claim relating to the service is
          limited to the amount you paid us in the three months before the claim
          arose.
        </p>
        <p>
          Nothing in these terms excludes liability that cannot be excluded by
          law.
        </p>
      </Clause>

      <Clause heading="11. Changes">
        <p>
          We may update these terms as the product changes. If a change
          materially affects you, we will tell you before it takes effect. The
          date at the top of this page shows when it was last changed, and
          continuing to use the service after that means you accept the update.
        </p>
      </Clause>

      <Clause heading="12. Governing Law">
        <p>
          These terms are governed by the laws of {GOVERNING_LAW}, and any
          dispute will be handled by the courts there.
        </p>
      </Clause>
    </LegalPage>
  );
}
