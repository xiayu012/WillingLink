import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy - WillingLink",
  description: "Privacy Policy for WillingLink",
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 md:px-6 lg:px-8">
      <h1 className="mb-8 font-semibold text-3xl">Privacy Policy</h1>
      <p className="mb-8 text-muted-foreground text-sm">
        Last updated: Feb 2026
      </p>

      <div className="prose prose-sm dark:prose-invert max-w-none">
        <p className="mb-6">
          This Privacy Policy describes how WillingLink (&quot;we&quot;,
          &quot;our&quot;, or &quot;us&quot;) handles information when you use
          our application.
        </p>

        <h2 className="mb-4 mt-8 font-semibold text-xl">Information Collection</h2>
        <ul className="mb-6 ml-6 list-disc space-y-2">
          <li>We do not require users to create accounts.</li>
          <li>
            We may collect limited technical information automatically, such as
            device type, operating system version, and basic usage data, solely
            for app functionality, stability, and improvement purposes.
          </li>
          <li>
            If you voluntarily enter text or content into the app, that content
            may be processed to provide the service. We do not sell personal
            data.
          </li>
        </ul>

        <h2 className="mb-4 mt-8 font-semibold text-xl">Use of Information</h2>
        <p className="mb-4">Collected information is used only to:</p>
        <ul className="mb-6 ml-6 list-disc space-y-2">
          <li>Operate and maintain the app</li>
          <li>Improve functionality and user experience</li>
          <li>Diagnose technical issues</li>
        </ul>

        <h2 className="mb-4 mt-8 font-semibold text-xl">Data Sharing</h2>
        <ul className="mb-6 ml-6 list-disc space-y-2">
          <li>We do not sell or rent user data.</li>
          <li>
            Information may be processed by third-party infrastructure providers
            strictly for hosting or computing purposes.
          </li>
        </ul>

        <h2 className="mb-4 mt-8 font-semibold text-xl">Data Retention</h2>
        <p className="mb-6">
          We retain information only as long as necessary to provide the
          service.
        </p>

        <h2 className="mb-4 mt-8 font-semibold text-xl">Children</h2>
        <p className="mb-6">
          This app is not intended for children under 13.
        </p>

        <h2 className="mb-4 mt-8 font-semibold text-xl">Changes</h2>
        <p className="mb-6">
          We may update this Privacy Policy from time to time. Changes will be
          posted on this page.
        </p>

        <h2 className="mb-4 mt-8 font-semibold text-xl">Contact</h2>
        <p className="mb-2">
          If you have any questions about this Privacy Policy, please contact:
        </p>
        <p className="mb-6">
          Email:{" "}
          <a
            className="text-primary hover:underline"
            href="mailto:contact@fretgone.com"
          >
            contact@fretgone.com
          </a>
        </p>
      </div>
    </div>
  );
}
