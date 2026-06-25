import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "About WillingLink by FretGone LLC",
  description:
    "Business information for WillingLink, a rental housing assistance service operated by FretGone LLC.",
};

const CONTACT_EMAIL = "contact@fretgone.com";
const BUSINESS_NAME = "FretGone LLC";
const BRAND_NAME = "WillingLink";

export default function AboutPage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-8 text-sm leading-relaxed">
      <h1 className="font-semibold text-2xl">
        About {BRAND_NAME} by {BUSINESS_NAME}
      </h1>
      <p>
        {BRAND_NAME} is a rental housing assistance service operated by{" "}
        {BUSINESS_NAME}. We help renters describe their housing needs, review
        available rental options, and coordinate service-related follow-up about
        listings, viewing details, and landlord or property contacts.
      </p>

      <h2 className="mt-4 font-semibold text-lg">Business Information</h2>
      <dl className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <dt className="font-medium">Legal business name</dt>
        <dd>{BUSINESS_NAME}</dd>
        <dt className="font-medium">Service name</dt>
        <dd>{BRAND_NAME}</dd>
        <dt className="font-medium">Business type</dt>
        <dd>Rental housing information and customer-care coordination</dd>
        <dt className="font-medium">Contact email</dt>
        <dd>
          <a
            className="underline hover:text-foreground"
            href={`mailto:${CONTACT_EMAIL}`}
          >
            {CONTACT_EMAIL}
          </a>
        </dd>
      </dl>

      <h2 className="mt-4 font-semibold text-lg">How SMS Is Used</h2>
      <p>
        Users may choose to receive transactional and informational SMS messages
        about their rental inquiry. Messages can include rental listing
        information, viewing coordination, landlord or property contact details,
        appointment reminders, and customer-care replies related to the user's
        housing search.
      </p>
      <p>
        SMS consent is collected on our public{" "}
        <Link className="underline hover:text-foreground" href="/submit-phone">
          rental updates request form
        </Link>
        . Users can reply STOP to opt out or HELP for assistance.
      </p>

      <h2 className="mt-4 font-semibold text-lg">Policies</h2>
      <p>
        See our{" "}
        <Link className="underline hover:text-foreground" href="/terms">
          Terms and Conditions
        </Link>{" "}
        and{" "}
        <Link className="underline hover:text-foreground" href="/privacy">
          Privacy Policy
        </Link>{" "}
        for more details about our service, SMS program, and data practices.
      </p>
    </main>
  );
}
