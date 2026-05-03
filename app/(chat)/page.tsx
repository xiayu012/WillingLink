"use client";

import Link from "next/link";
import { useState } from "react";

export default function Page() {
  const [phone, setPhone] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitted(true);
    setPhone("");
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <div className="flex flex-1 flex-col items-center justify-center px-4">
        <p className="mb-6 max-w-md text-center text-sm text-muted-foreground">
          Welcome to WillingLink by FretGone LLC. Please submit your phone
          number, and I’ll text you to discuss your needs and help you find
          suitable rental options. By opting in, you may receive SMS messages
          with rental listings, landlord contact details, and viewing
          arrangements. You can also reply to ask questions, share your housing
          preferences, and discuss living needs so we can better match you with
          the right place.
        </p>
        <form
          onSubmit={handleSubmit}
          className="flex w-full max-w-sm flex-col gap-4"
        >
          <label htmlFor="phone" className="text-sm font-medium">
            Phone number
          </label>
          <input
            id="phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Please enter your phone number"
            className="rounded border border-input bg-background px-3 py-2 text-sm"
            required
          />
          <button
            type="submit"
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Submit
          </button>
        </form>
        {submitted && (
          <p className="mt-4 text-sm text-muted-foreground">
            Submitted successfully.
          </p>
        )}
      </div>
      <footer className="border-t px-4 py-3 text-center text-xs text-muted-foreground">
        <span className="mr-2">© {new Date().getFullYear()} WillingLink</span>
        <Link href="/terms" className="underline hover:text-foreground">
          Terms and Conditions
        </Link>
        <span className="mx-1">·</span>
        <Link href="/privacy" className="underline hover:text-foreground">
          Privacy Policy
        </Link>
      </footer>
    </div>
  );
}
