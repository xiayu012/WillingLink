

/** 小红书租房帖（复制按钮上报 + 可选结构化字段） */
export const xhsRentalListing = pgTable("XhsRentalListing", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  sourceUrl: text("sourceUrl").notNull(),
  title: text("title"),
  rawText: text("rawText").notNull(),
  rent: text("rent"),
  deposit: text("deposit"),
  availableFrom: text("availableFrom"),
  leaseEndDate: text("leaseEndDate"),
  listingType: text("listingType"),
  bedrooms: text("bedrooms"),
  bathrooms: text("bathrooms"),
  roomType: text("roomType"),
  propertyName: text("propertyName"),
  locationText: text("locationText"),
  furnished: text("furnished"),
  contactMethod: text("contactMethod"),
  /** 上传到 Blob 后的公开 URL 列表，与 sourceUrl 同一帖 */
  imageUrls: json("imageUrls").$type<string[] | null>(),
  /** 论坛帖时间：优先更新于，无则发布于 */
  postedAt: timestamp("postedAt", { withTimezone: true }),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
});

export type XhsRentalListing = InferSelectModel<typeof xhsRentalListing>;

/** 小红书求租帖：租客发布找房需求 */
export const xhsRentalWanted = pgTable("XhsRentalWanted", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  sourceUrl: text("sourceUrl").notNull(),
  title: text("title"),
  rawText: text("rawText").notNull(),
  budgetText: text("budgetText"),
  budgetMin: text("budgetMin"),
  budgetMax: text("budgetMax"),
  preferredLocations: text("preferredLocations"),
  moveInDate: text("moveInDate"),
  leaseDuration: text("leaseDuration"),
  wantedType: text("wantedType"),
  bedrooms: text("bedrooms"),
  bathrooms: text("bathrooms"),
  roomType: text("roomType"),
  furnished: text("furnished"),
  pets: text("pets"),
  occupation: text("occupation"),
  householdSize: text("householdSize"),
  gender: text("gender"),
  requirements: text("requirements"),
  contactMethod: text("contactMethod"),
  imageUrls: json("imageUrls").$type<string[] | null>(),
  aiConfidence: text("aiConfidence"),
  aiReason: text("aiReason"),
  postedAt: timestamp("postedAt", { withTimezone: true }),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
});

export type XhsRentalWanted = InferSelectModel<typeof xhsRentalWanted>;

/** 小红书经验/科普/其他非交易帖 */
export const xhsRentalOther = pgTable("XhsRentalOther", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  sourceUrl: text("sourceUrl").notNull(),
  rawText: text("rawText").notNull(),
  title: text("title"),
  aiReason: text("aiReason"),
  imageUrls: json("imageUrls").$type<string[] | null>(),
  postedAt: timestamp("postedAt", { withTimezone: true }),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
});

export type XhsRentalOther = InferSelectModel<typeof xhsRentalOther>;