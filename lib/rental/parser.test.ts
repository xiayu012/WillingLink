import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseContacts,
  parsePublishedAtRaw,
  parseStructuredRentalData,
} from "./parser";

describe("rental parser", () => {
  test("extracts structured fields from mixed zh/en rental content", () => {
    const parsed = parseStructuredRentalData({
      title: "Fremont 主卧出租 $1280/月 可宠物",
      contentText:
        "位于Fremont 94538，整租或分租都可，微信: house888，电话 510-123-4567，女生优先，6个月起租。",
    });

    assert.equal(parsed.priceRaw, "$1280");
    assert.match(parsed.contactRaw ?? "", /510-123-4567/);
    assert.match(parsed.contactRaw ?? "", /微信/);
    assert.equal(parsed.structured.currency, "USD");
    assert.equal(parsed.structured.priceMin, 1280);
    assert.equal(parsed.structured.city, "Fremont");
    assert.equal(parsed.structured.contactWechat, "house888");
    assert.equal(parsed.structured.contactPhone, "510-123-4567");
    assert.equal(parsed.structured.genderPreference, "female_only");
    assert.equal(parsed.structured.leaseTermMonths, 6);
    assert.equal(parsed.structured.petPolicy, "allowed");
  });

  test("parses contact variants", () => {
    const contacts = parseContacts(
      "wechat:abc_xyz mail me at test@example.com call +1 (415) 222-7788"
    );

    assert.equal(contacts.contactWechat, "abc_xyz");
    assert.equal(contacts.contactEmail, "test@example.com");
    assert.match(contacts.contactPhone ?? "", /415/);
  });

  test("parses absolute date and time-only formats", () => {
    const absolute = parsePublishedAtRaw("2026-03-30");
    assert.ok(absolute);
    assert.ok(absolute.toISOString().startsWith("2026-03-30"));

    const timeOnly = parsePublishedAtRaw("8:39 pm");
    assert.ok(timeOnly);
    assert.equal(timeOnly.getHours(), 20);
    assert.equal(timeOnly.getMinutes(), 39);
  });
});
