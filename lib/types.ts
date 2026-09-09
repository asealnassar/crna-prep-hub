export type School = {
  id: string
  name: string
  location_city: string
  location_state: string
  program_type: 'DNP' | 'MSN' | 'Both'
  program_length_months: number
  tuition_total: number
  gpa_requirement: number
  icu_experience_months: number
  application_deadline: string
  accepts_new_grad_icu: boolean
  acceptance_rate: number
  nclex_pass_rate: number
  website_url: string
  created_at: string
}

export type UserProfile = {
  id: string
  email: string
  /**
   * 'security-test' is test infrastructure, not a product tier: it holds only
   * throwaway accounts so the broadcast-boundary suite can call the real
   * send_tier_broadcast without reaching a member. It is deliberately absent
   * from ALLOWED_TIERS in the broadcast email route, so the cohort cannot
   * reach Resend, and from the admin tier selector, so it cannot be chosen.
   *
   * Kept as a closed union rather than widened to `string`: every gate in the
   * app treats an unrecognised tier as the least privileged case, and that
   * only stays true if adding a value remains a deliberate edit.
   */
  subscription_tier: 'free' | 'premium' | 'ultimate' | 'security-test'
  stripe_customer_id: string | null
  has_used_free_interview: boolean
  created_at: string
}
