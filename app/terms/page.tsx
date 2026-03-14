import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "SMS Terms & Conditions – ABC Housing LLC",
};

export default function TermsPage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-8 text-sm leading-relaxed">
      <h1 className="text-2xl font-semibold">
        SMS Terms &amp; Conditions – FretGone LLC
      </h1>

      <h2 className="mt-4 text-lg font-semibold">Program Name</h2>
      <p>FretGone Rental Info Alerts</p>

      <h2 className="mt-4 text-lg font-semibold">Description</h2>
      <p>
        Subscribers will receive SMS notifications about available rental
        listings and related updates.
      </p>

      <h2 className="mt-4 text-lg font-semibold">Message Frequency</h2>
      <p>
        Message frequency may vary depending on listing availability but will
        generally not exceed several messages per week.
      </p>

      <h2 className="mt-4 text-lg font-semibold">Message and Data Rates</h2>
      <p>
        Message and data rates may apply depending on the subscriber&apos;s
        mobile carrier plan.
      </p>

      <h2 className="mt-4 text-lg font-semibold">Opt-Out</h2>
      <p>
        You may opt out of the SMS service at any time by replying STOP to any
        message.
      </p>

      <h2 className="mt-4 text-lg font-semibold">Help</h2>
      <p>
        For help, reply HELP to any message or contact{" "}
        <a
          href="mailto:support@abchousing.com"
          className="underline hover:text-foreground"
        >
          contact@fretgone.com
        </a>
        .
      </p>

      <h2 className="mt-4 text-lg font-semibold">Eligibility</h2>
      <p>You must be the authorized user of the mobile number provided.</p>

      <h2 className="mt-4 text-lg font-semibold">Service Provider</h2>
      <p>
        This SMS notification service is operated by FretGone LLC.
      </p>

      <h2 className="mt-4 text-lg font-semibold">Disclaimer</h2>
      <p>
        FretGone LLC provides information about rental listings but does not
        guarantee the accuracy, safety, or availability of any listing. Users
        are responsible for independently verifying listings and exercising
        caution when interacting with property owners.
      </p>
    </main>
  );
}

