/** Curated campaign categories shown to hosts when creating a campaign and
 *  available for filtering on the home list. Keep in sync with the Flutter
 *  constant list (lib/features/campaigns/models.dart) — the API validates
 *  against this list and rejects unknown values. */
export const CAMPAIGN_CATEGORIES = [
  "Other",
  "Church & Ministry",
  "Missions & Evangelism",
  "Music & Worship",
  "Bible School & Discipleship",
  "Education & School Fees",
  "Bursary & Scholarships",
  "Medical & Health",
  "Disability Support",
  "Funeral & Memorial",
  "Children & Orphans",
  "Women's Empowerment",
  "Youth & Sports",
  "Marriage & Family",
  "Elderly Care",
  "Community Development",
  "Food & Hunger Relief",
  "Water & Sanitation",
  "Solar & Electricity",
  "Disaster & Emergency Relief",
  "Refugee & Migrant Support",
  "Prison Ministry",
  "Agriculture & Farming",
  "Livestock & Seeds",
  "Business & Startups",
  "Construction & Buildings",
  "Transport & Vehicles",
  "Clothing & Household",
  "Technology & Devices",
  "Weddings & Celebrations",
  "Environmental & Conservation",
] as const;

export function isValidCategory(category: unknown): category is string {
  return typeof category === "string" && (CAMPAIGN_CATEGORIES as readonly string[]).includes(category);
}
