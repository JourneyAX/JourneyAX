/**
 * Retired: overlaying a draft on an activated release also copied its verification stamp.
 * A preview must publish an actual release into isolated dev/test storage and use the canonical runtime.
 * This entry point fails before loading settings, opening storage or starting a service.
 */
throw new Error('Draft-overlay runtime is retired. Publish the draft through the existing Business Pack publisher into isolated dev/test storage, then start the canonical runtime with that storage. Verification stamps cannot be reused for changed content.');
export {};
