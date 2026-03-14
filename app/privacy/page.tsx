import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy – FretGone LLC",
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-8 text-sm leading-relaxed">
      <h1 className="text-2xl font-semibold">
        Privacy Policy – FretGone LLC
      </h1>
      <p>
        FretGone LLC respects your privacy and is committed to protecting
        your personal information.
      </p>

      <h2 className="mt-4 text-lg font-semibold">Information We Collect</h2>
      <p>
        We collect phone numbers and related information when users voluntarily
        subscribe to receive rental listing notifications.
      </p>

      <h2 className="mt-4 text-lg font-semibold">How We Use Information</h2>
      <p>
        The information collected is used solely to send requested SMS
        notifications about rental listings and related service updates.
      </p>

      <h2 className="mt-4 text-lg font-semibold">Information Sharing</h2>
      <p>
        FretGone LLC does not sell, rent, or share personal information with
        third parties for marketing purposes.
      </p>

      <h2 className="mt-4 text-lg font-semibold">Data Security</h2>
      <p>
        We take reasonable steps to protect personal information from
        unauthorized access or disclosure.
      </p>

      <h2 className="mt-4 text-lg font-semibold">Opt-Out</h2>
      <p>
        Subscribers can opt out of receiving SMS messages at any time by
        replying STOP to any message.
      </p>

      <h2 className="mt-4 text-lg font-semibold">Contact</h2>
      <p>
        For questions regarding this policy, please contact:{" "}
        <a
          href="mailto:support@abchousing.com"
          className="underline hover:text-foreground"
        >
          contact@fretgone.com
        </a>
        .
      </p>

      <h2 className="mt-4 text-lg font-semibold">Company</h2>
      <p>FretGone LLC</p>
    </main>
  );
}

