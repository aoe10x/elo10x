import type { EloRanking, PlayerProfile } from './types.ts';

/**
 * Resolves the country code for a player, prioritizing any valid country
 * found among all merged profile IDs over "Unknown" or empty values.
 */
export function resolveMergedCountry(
  p: EloRanking,
  getProfile: (id: number) => Partial<PlayerProfile> | undefined
): string {
  const ids = p.merged_ids && p.merged_ids.length > 0 ? p.merged_ids : [p.profile_id];
  
  for (const id of ids) {
    const profile = getProfile(id);
    const country = profile?.country;
    if (country && country !== 'Unknown' && country.trim() !== '') {
      return country;
    }
  }

  const canonicalProfile = getProfile(p.profile_id);
  return canonicalProfile?.country || 'Unknown';
}
