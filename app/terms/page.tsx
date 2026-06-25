import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms and Conditions – WillingLink by FretGone LLC",
};

const CONTACT_EMAIL = "contact@fretgone.com";
const BUSINESS_NAME = "FretGone LLC";
const BRAND_NAME = "WillingLink";
const PROGRAM_NAME = "FretGone Rental Info Alerts";

export default function TermsPage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-8 text-sm leading-relaxed">
      <h1 className="font-semibold text-2xl">
        Terms and Conditions – {BRAND_NAME} by {BUSINESS_NAME}
      </h1>
      <p>
        By accessing or using this website and our services, you agree to these
        Terms and Conditions and our{" "}
        <Link className="underline hover:text-foreground" href="/privacy">
          Privacy Policy
        </Link>
        .
      </p>

      <h2 className="mt-4 font-semibold text-lg">1. Acceptance of Terms</h2>
      <p>
        If you do not agree to these terms, please do not use this website or
        submit your contact information.
      </p>

      <h2 className="mt-4 font-semibold text-lg">2. Use of Services</h2>
      <p>
        {BRAND_NAME} helps users discuss housing needs and connect with suitable
        rental options. You agree to use the site only for lawful purposes and
        to provide accurate contact information.
      </p>

      <h2 className="mt-4 font-semibold text-lg">3. SMS Program</h2>
      <p>
        <strong>Program name:</strong> {PROGRAM_NAME}
      </p>
      <p>
        If you provide your phone number and opt in on our contact form, you
        agree to receive{" "}
        <strong>transactional and informational text messages</strong> from{" "}
        {BUSINESS_NAME} ({BRAND_NAME}) related to your rental inquiry. These
        messages may include viewing confirmations, landlord contact details,
        follow-up questions about your housing needs, and related customer-care
        communications.
      </p>
      <p>
        This is not a promotional marketing program. We do not send bulk
        advertising blasts unrelated to your inquiry. Message frequency may vary
        depending on your request and listing activity.
      </p>
      <p>
        Consent to receive SMS messages is not a condition of purchasing or
        using our services. You can contact us by email instead at{" "}
        <a
          className="underline hover:text-foreground"
          href={`mailto:${CONTACT_EMAIL}`}
        >
          {CONTACT_EMAIL}
        </a>
        .
      </p>
      <p>
        Message and data rates may apply. You may opt out at any time by
        replying <strong>STOP</strong> to any text message. For help, reply{" "}
        <strong>HELP</strong> or contact{" "}
        <a
          className="underline hover:text-foreground"
          href={`mailto:${CONTACT_EMAIL}`}
        >
          {CONTACT_EMAIL}
        </a>
        .
      </p>
      <p>
        You must be the authorized user of the mobile number you provide. We are
        not responsible for messages received by someone else if an incorrect
        number is submitted.
      </p>

      <h2 className="mt-4 font-semibold text-lg">
        4. No Guarantee of Listings
      </h2>
      <p>
        {BUSINESS_NAME} provides information and coordination assistance but
        does not guarantee the accuracy, safety, availability, or suitability of
        any rental listing. You are responsible for independently verifying
        listings and exercising caution when contacting landlords or attending
        viewings.
      </p>

      <h2 className="mt-4 font-semibold text-lg">5. Intellectual Property</h2>
      <p>
        All content, branding, and materials on this site are owned by{" "}
        {BUSINESS_NAME} and may not be copied or reused without permission.
      </p>

      <h2 className="mt-4 font-semibold text-lg">
        6. Disclaimers and Limitation of Liability
      </h2>
      <p>
        The site and services are provided on an &quot;as is&quot; basis. To the
        fullest extent permitted by law, {BUSINESS_NAME} is not liable for
        damages arising from your use of the website, reliance on listing
        information, or interactions with third-party landlords.
      </p>

      <h2 className="mt-4 font-semibold text-lg">7. Governing Law</h2>
      <p>
        These Terms are governed by the laws of the State of California, without
        regard to conflict-of-law principles.
      </p>

      <h2 className="mt-4 font-semibold text-lg">8. Contact</h2>
      <p>
        For questions regarding these Terms, please contact:{" "}
        <a
          className="underline hover:text-foreground"
          href={`mailto:${CONTACT_EMAIL}`}
        >
          {CONTACT_EMAIL}
        </a>
        .
      </p>

      <p className="mt-4 text-muted-foreground">
        <strong>Service provider:</strong> {BUSINESS_NAME}
      </p>
    </main>
  );
}
