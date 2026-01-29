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
  subscription_tier: 'free' | 'premium' | 'ultimate'
  stripe_customer_id: string | null
  has_used_free_interview: boolean
  created_at: string
}
