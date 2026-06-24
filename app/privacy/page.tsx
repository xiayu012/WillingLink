import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy – WillingLink by FretGone LLC",
};

const CONTACT_EMAIL = "contact@fretgone.com";

export default function PrivacyPage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-8 text-sm leading-relaxed">
      <h1 className="text-2xl font-semibold">
        Privacy Policy – WillingLink by FretGone LLC
      </h1>
      <p>
        This Privacy Policy describes how FretGone LLC (&quot;we&quot;,
        &quot;us&quot;, or &quot;our&quot;) collects, uses, and discloses your
        information when you use the WillingLink website and related services.
      </p>

      <h2 className="mt-4 text-lg font-semibold">1. Information We Collect</h2>
      <p>We may collect the following information when you use our site:</p>
      <ul className="list-disc space-y-1 pl-6">
        <li>First and last name</li>
        <li>Email address</li>
        <li>Phone number</li>
        <li>
          Housing preferences or other details you voluntarily provide through
          forms or messages
        </li>
        <li>
          Technical information such as IP address, browser type, and device
          information
        </li>
      </ul>

      <h2 className="mt-4 text-lg font-semibold">2. How We Use Your Information</h2>
      <p>We use the information we collect to:</p>
      <ul className="list-disc space-y-1 pl-6">
        <li>Respond to your rental inquiries and housing requests</li>
        <li>
          Coordinate viewings, share landlord contact details, and provide
          customer support related to your search
        </li>
        <li>Send service-related updates you have requested or opted into</li>
        <li>Improve our website, services, and user experience</li>
      </ul>
      <p>
        We do not use your information for unrelated promotional campaigns. Our
        SMS program is limited to transactional and informational messages tied
        to your housing inquiry.
      </p>

      <h2 className="mt-4 text-lg font-semibold">3. SMS Communication</h2>
      <p>
        If you submit your phone number and opt in on our contact form, you
        consent to receive <strong>transactional and informational text
        messages</strong> from FretGone LLC (WillingLink) about your rental
        inquiry. These messages may include viewing confirmations, landlord
        contact details, follow-up questions about your housing needs, and
        related customer-care messages.
      </p>
      <p>
        Message frequency may vary depending on your inquiry and listing
        activity. Message and data rates may apply according to your mobile
        carrier plan. You may opt out of SMS communication at any time by
        replying <strong>STOP</strong> to any message. For help, reply{" "}
        <strong>HELP</strong> or contact us at{" "}
        <a
          className="underline hover:text-foreground"
          href={`mailto:${CONTACT_EMAIL}`}
        >
          {CONTACT_EMAIL}
        </a>
        .
      </p>
      <p>
        We do not sell your phone number. SMS delivery may involve trusted
        service providers (such as messaging platforms) solely to deliver
        messages on our behalf.
      </p>

      <h2 className="mt-4 text-lg font-semibold">4. Information Sharing</h2>
      <p>
        We do not sell your personal information. We may share information only
        as needed to operate our services—for example, with SMS delivery
        providers, hosting providers, or when required by law.
      </p>

      <h2 className="mt-4 text-lg font-semibold">5. Data Retention and Security</h2>
      <p>
        We retain personal information only as long as necessary to fulfill the
        purposes described in this policy or as required by law. We use
        reasonable administrative, technical, and organizational measures to
        protect your information.
      </p>

      <h2 className="mt-4 text-lg font-semibold">6. Your Rights</h2>
      <p>You may contact us to:</p>
      <ul className="list-disc space-y-1 pl-6">
        <li>Request access to or a copy of your personal information</li>
        <li>Update or correct your contact details</li>
        <li>Withdraw SMS consent by replying STOP or contacting us directly</li>
        <li>Request deletion of your information, subject to legal obligations</li>
      </ul>

      <h2 className="mt-4 text-lg font-semibold">7. Contact Us</h2>
      <p>
        For questions about this Privacy Policy, please contact:{" "}
        <a
          className="underline hover:text-foreground"
          href={`mailto:${CONTACT_EMAIL}`}
        >
          {CONTACT_EMAIL}
        </a>
        .
      </p>

      <p className="mt-4 text-muted-foreground">
        See also our{" "}
        <Link className="underline hover:text-foreground" href="/terms">
          Terms and Conditions
        </Link>
        .
      </p>

      <h2 className="mt-4 text-lg font-semibold">Company</h2>
      <p>FretGone LLC — WillingLink</p>
    </main>
  );
}
