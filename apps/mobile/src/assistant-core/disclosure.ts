/** Product copy for the real phone → laptop → provider boundary; no provider-retention promises. */
export const assistantDataDisclosure = Object.freeze({
  processing:
    'Your message, relevant conversation context, saved preferences, relevant meal-plan details, date and time-zone context, and recipe evidence pass through your laptop to Gemini.',
  operator: 'The laptop operator can inspect information processed on that laptop.',
  local:
    'Recipes, favourites, meal plans and shopping work locally. AI replies require the connected gateway and provider.',
  clearing:
    'Clearing chat removes this conversation and its draft. It does not undo saved meals, preferences or committed actions, or erase information already processed by Gemini.',
  stopping:
    'Stopping a request ends waiting where possible. It cannot unsend data already delivered or undo a completed local action.',
  provider:
    'This private test uses Gemini’s free service. Google uses submitted content and responses to improve its products, and human reviewers may see them. Use fictional, non-sensitive information only; do not send personal or confidential details. CookMate does not promise zero retention.',
});
