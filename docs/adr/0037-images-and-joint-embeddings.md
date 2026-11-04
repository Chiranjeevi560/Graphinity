# ADR 0037: Joint text-image embeddings as an engine; no image uploads without the owner's decision

Date: 2026-11-04. Status: accepted for the engine; uploads are the owner's decision.

## Context

The report lists joint text-image embeddings as not built and multimodal support as "engines only; Graphinity takes no
images". The existing engines (`intelligence/media.ts`) are perceptual hashes for duplicates, EXIF stripping and
receipt-text checks. The owner asked to build what code can build and keep it off.

## Decision

- **Built:** `ml/joint-embedding.ts`, two linear maps trained with the symmetric InfoNCE loss CLIP uses, so an image's
  features and a text's vector land close when they belong together. Hand-written, no downloaded weights. On synthetic
  pairs it finds each held-out text's own image among 100 more than 30% of the time, against 1% by chance and under
  10% untrained (the test asserts it).
- **Not built, on purpose: image uploads.** Hosting people's photos brings legal duties before the first upload, above
  all detecting and reporting child sexual abuse material (India's IT Rules 2021 and POCSO; in the US, 18 U.S.C. 2258A
  for any US-hosted service), plus storage cost and a new kind of personal data (faces, places, metadata). A switched-
  off upload path would still be code that, once on, takes images with none of that in place. It waits for the owner.
- **No pre-trained image model:** a useful image encoder means downloading weights (CLIP, SigLIP), a new dependency of
  hundreds of megabytes from outside sources, which this project doesn't take without the owner's say.

## What turning images on would need

1. The owner's decision to take images, and a lawyer's view of the duties above.
2. A screening service for known abuse material (free ones exist for eligible services, such as Microsoft PhotoDNA or
   Cloudflare's CSAM scanning tool, each with its own application) and a reporting process.
3. Storage within free limits (Supabase Storage's free tier) and the privacy page updated.
4. Then: an upload route behind a switch, EXIF stripped (`stripExif`), duplicates refused (`pHash`), and image
   features for this engine.
