import { z } from 'zod';

// Visibility classification for attachment items — documents, comments,
// custom-field values (K-13). Mandatory wherever data can reach the customer
// portal: like piiClass on events, a classification is only total if it was
// never optional. Engine-owned tables handle their own flags; this is the
// kernel-surface convention.

export const visibility = z.enum(['internal', 'customer']);
export type Visibility = z.infer<typeof visibility>;
