"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const BUSINESS_NAME = "FretGone LLC";
const BRAND_NAME = "WillingLink";
const CONTACT_EMAIL = "contact@fretgone.com";

export default function SubmitPhonePage() {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [transactionalSms, setTransactionalSms] = useState(false);
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitted(true);
    setFirstName("");
    setLastName("");
    setPhone("");
    setEmail("");
    setTransactionalSms(false);
    setAcceptTerms(false);
  };

  return (
    <div className="flex min-h-dvh flex-col bg-muted/40">
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-10">
        <div className="w-full max-w-lg rounded-lg border bg-background p-6 shadow-sm md:p-8">
          <div className="mb-6 flex flex-col items-center text-center">
            <div
              aria-hidden="true"
              className="mb-4 flex h-20 w-full max-w-xs items-center justify-center rounded-md border-2 border-muted-foreground/30 border-dashed bg-muted/50 font-semibold text-lg tracking-tight"
            >
              {BRAND_NAME}
            </div>
            <h1 className="mb-2 font-semibold text-2xl tracking-tight">
              Request rental updates by text
            </h1>
            <p className="text-muted-foreground text-sm">
              Welcome to {BRAND_NAME} by {BUSINESS_NAME}. Please submit your
              contact details so we can text you about your housing needs,
              coordinate viewings, and connect you with suitable landlords.
            </p>
          </div>

          {submitted ? (
            <output className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-center text-green-800 text-sm">
              Submitted successfully. If you opted in to SMS, we will reach out
              shortly.
            </output>
          ) : (
            <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="first-name">Name</Label>
                  <Input
                    autoComplete="given-name"
                    id="first-name"
                    onChange={(e) => setFirstName(e.target.value)}
                    placeholder="First name"
                    required
                    type="text"
                    value={firstName}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="last-name">Last name</Label>
                  <Input
                    autoComplete="family-name"
                    id="last-name"
                    onChange={(e) => setLastName(e.target.value)}
                    placeholder="Last name"
                    type="text"
                    value={lastName}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="phone">Phone number</Label>
                  <Input
                    autoComplete="tel"
                    id="phone"
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="(555) 555-5555"
                    required
                    type="tel"
                    value={phone}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    autoComplete="email"
                    id="email"
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    type="email"
                    value={email}
                  />
                </div>
              </div>

              <p className="text-left text-muted-foreground text-xs leading-relaxed">
                This form is for housing inquiries only. We send{" "}
                <strong>transactional and informational SMS</strong> related to
                your request—not promotional marketing blasts. See our{" "}
                <Link
                  className="text-primary underline underline-offset-2"
                  href="/privacy"
                >
                  Privacy Policy
                </Link>{" "}
                and{" "}
                <Link
                  className="text-primary underline underline-offset-2"
                  href="/terms"
                >
                  Terms and Conditions
                </Link>{" "}
                for details.
              </p>

              <fieldset className="flex flex-col gap-4">
                <legend className="sr-only">SMS and legal consent</legend>

                <label
                  className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm leading-relaxed"
                  htmlFor="transactional-sms"
                >
                  <input
                    checked={transactionalSms}
                    className="mt-1 size-4 shrink-0 accent-primary"
                    id="transactional-sms"
                    name="transactional-sms"
                    onChange={(e) => setTransactionalSms(e.target.checked)}
                    required
                    type="checkbox"
                  />
                  <span>
                    By checking, you agree to receive{" "}
                    <strong>transactional/informational SMS</strong> regarding
                    your rental inquiry, viewing coordination, landlord contact
                    details, and customer care from {BUSINESS_NAME} (
                    {BRAND_NAME}
                    ). Message frequency may vary. Message and data rates may
                    apply. Reply <strong>HELP</strong> for help or{" "}
                    <strong>STOP</strong> to opt out.
                  </span>
                </label>

                <label
                  className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm leading-relaxed"
                  htmlFor="accept-terms"
                >
                  <input
                    checked={acceptTerms}
                    className="mt-1 size-4 shrink-0 accent-primary"
                    id="accept-terms"
                    name="accept-terms"
                    onChange={(e) => setAcceptTerms(e.target.checked)}
                    required
                    type="checkbox"
                  />
                  <span>
                    By checking, I accept the{" "}
                    <Link
                      className="text-primary underline underline-offset-2"
                      href="/terms"
                    >
                      Terms and Conditions
                    </Link>{" "}
                    &amp;{" "}
                    <Link
                      className="text-primary underline underline-offset-2"
                      href="/privacy"
                    >
                      Privacy Policy
                    </Link>
                    .
                  </span>
                </label>
              </fieldset>

              <Button className="w-full" size="lg" type="submit">
                Submit rental inquiry
              </Button>
            </form>
          )}
        </div>
        <p className="mt-4 max-w-lg text-center text-muted-foreground text-xs">
          Need help without SMS? Email{" "}
          <a
            className="underline hover:text-foreground"
            href={`mailto:${CONTACT_EMAIL}`}
          >
            {CONTACT_EMAIL}
          </a>
          .
        </p>
      </div>

      <footer className="border-t bg-background px-4 py-3 text-center text-muted-foreground text-xs">
        <span className="mr-2">
          © {new Date().getFullYear()} {BRAND_NAME}
        </span>
        <Link className="underline hover:text-foreground" href="/terms">
          Terms and Conditions
        </Link>
        <span className="mx-1">·</span>
        <Link className="underline hover:text-foreground" href="/privacy">
          Privacy Policy
        </Link>
        <span className="mx-1">·</span>
        <Link className="underline hover:text-foreground" href="/about">
          About
        </Link>
      </footer>
    </div>
  );
}
