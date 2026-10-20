import type { CsvPlatform } from '../../data-layer/src/tabular/types.ts';

interface WindsorSource {
  source: string; sourceProvider: string; label: string; platform: CsvPlatform;
  fields: readonly string[]; identity: readonly string[]; numericAccount?: boolean;
  completedDays?: boolean; notes: string;
}

/** Native columns and row grain, not cross-platform metric equivalents. */
export const WINDSOR_SOURCES = {
  linkedin: {
    source: 'linkedin_organic', sourceProvider: 'linkedin', label: 'LinkedIn', platform: 'linkedin', numericAccount: true,
    fields: ['account_id', 'date', 'post_id', 'share_text', 'share_published_time', 'share_url',
      'share_like_count', 'share_comment_count', 'share_count', 'share_impression_count', 'share_clicks_count'],
    identity: ['post_id'],
    notes: 'Native post/day fields. Metric periods require source verification; negative like adjustments remain unchanged.',
  },
  facebook: {
    source: 'facebook_organic', sourceProvider: 'facebook', label: 'Facebook Pages', platform: 'facebook', numericAccount: true,
    fields: ['account_id', 'date', 'post_id', 'post_message', 'post_created_time', 'permalink_url',
      'post_reactions_total', 'post_comments_total', 'post_activity_by_action_type_share'],
    identity: ['post_id'],
    notes: 'Native post/date rows. Comments are top-level comments; reaction scope and metric periods require source verification. Repeated post totals must not be summed across dates or snapshots.',
  },
  instagram: {
    source: 'instagram', sourceProvider: 'instagram', label: 'Instagram', platform: 'instagram', numericAccount: true,
    fields: ['account_id', 'date', 'media_id', 'media_caption', 'timestamp', 'media_permalink', 'media_type',
      'media_like_count', 'media_comments_count'],
    identity: ['media_id'],
    notes: 'Native media/date rows. Counts exclude some boosted and cross-posted engagement and may differ from the app. Repeated media totals must not be summed across dates or snapshots.',
  },
  mailchimp: {
    source: 'mailchimp', sourceProvider: 'mailchimp', label: 'Mailchimp', platform: 'unspecified',
    fields: ['account_id', 'date', 'campaign_id', 'campaign_title', 'subject_line', 'send_time',
      'emails_sent', 'opens_total', 'unique_opens', 'clicks_total', 'unique_clicks', 'unsubscribed'],
    identity: ['campaign_id'],
    notes: 'Campaign report totals; date is the campaign send date, not the date of each open or click. Opens can include automated privacy activity. No subscriber-level data is collected.',
  },
  ga4: {
    source: 'googleanalytics4', sourceProvider: 'google-analytics', label: 'Google Analytics', platform: 'unspecified',
    numericAccount: true, completedDays: true,
    fields: ['account_id', 'date', 'session_default_channel_group', 'sessions', 'active_users', 'engaged_sessions', 'property_timezone'],
    identity: ['session_default_channel_group'],
    notes: 'Day/channel report in the property timezone. Active users are distinct within each row, not additive across days or channels. Reporting lag, thresholding and coverage require verification.',
  },
  youtube: {
    source: 'youtube', sourceProvider: 'youtube', label: 'YouTube', platform: 'unspecified', completedDays: true,
    fields: ['account_id', 'date', 'video', 'video_title', 'videourl', 'views', 'likes', 'comments', 'shares', 'estimated_minutes_watched'],
    identity: ['video'],
    notes: 'Video/day analytics, not lifetime video totals. Views and watch minutes are native YouTube metrics, not impressions. Reporting lag and coverage require verification.',
  },
} as const satisfies Record<string, WindsorSource>;

export type WindsorProvider = keyof typeof WINDSOR_SOURCES;
export const windsorSource = (provider: WindsorProvider): WindsorSource => WINDSOR_SOURCES[provider];
