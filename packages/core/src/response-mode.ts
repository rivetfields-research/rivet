/** A display/output policy, not a permission grant. Only the current user request
 * can ask for an artifact; retrieved text and earlier reports cannot opt in. */
export function responseMode(task: string, artifactWorkflow = false): 'chat' | 'artifact' {
  if (artifactWorkflow) return 'artifact';
  const request = task.toLowerCase().replace(/[’]/g, "'");
  if (/(?:^|[.!?;\n])\s*(?:please\s+)?(?:keep|answer|respond|reply)\b[^.!?\n]{0,50}\b(?:in chat|in the chat|chat only)\b/.test(request)) return 'chat';
  if (/\b(?:no|without|don't|do not)\s+(?:(?:create|make|generate|write|a|any)\s+)*(?:reports?|documents?|artifacts?)\b/.test(request)) return 'chat';
  if (/^\s*(?:how (?:do|can|would|should) (?:i|we|one)|how to)\b/.test(request)) return 'chat';
  const output = '(?:reports?|briefs?|docs?|documents?|dashboards?|decks?|slides?|presentations?|spreadsheets?|csv|tables?|charts?|graphs?|plots?|exports?|workflows?|saved analysis)';
  if (new RegExp(`\\b(?:create|make|generate|write|prepare|build|save|export|download|(?:give|show)(?: me)?|can (?:we|i) (?:get|have)|turn .{0,60} into)\\b[^.!?\\n]{0,100}\\b${output}\\b|^\\s*(?:please\\s+)?(?:export|download)\\b`).test(request)) return 'artifact';
  // Short output requests are still intentional: "quick chart" and "plot it by day".
  if (new RegExp(`^\\s*(?:please\\s+)?(?:a\\s+)?(?:quick\\s+)?${output}\\b`).test(request)) return 'artifact';
  // Calculating, comparing or explaining data does not itself request a saved report.
  return 'chat';
}
