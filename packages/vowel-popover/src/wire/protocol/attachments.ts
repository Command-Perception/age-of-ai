import * as Schema from "effect/Schema"

export const MAX_INPUT_ATTACHMENTS = 4
export const MAX_ATTACHMENT_IMAGES = 4
export const MAX_ATTACHMENT_TEXT = 100_000
export const MAX_ATTACHMENT_IMAGE_URL = 2_000_000
export const MAX_ATTACHMENT_PAYLOAD = 8_000_000

export const AttachmentPart = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String.check(Schema.isMaxLength(MAX_ATTACHMENT_TEXT)) }),
  Schema.Struct({
    type: Schema.Literal("image"),
    data_url: Schema.String.check(Schema.isMaxLength(MAX_ATTACHMENT_IMAGE_URL), Schema.isPattern(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/)),
  }),
])
export const InputAttachment = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  media_type: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  content: Schema.Array(AttachmentPart).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_ATTACHMENT_IMAGES + 1)),
})
export type InputAttachment = typeof InputAttachment.Type
export const InputAttachments = Schema.Struct({
  type: Schema.Literal("vowel.input.attachments"),
  attachments: Schema.Array(InputAttachment).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_INPUT_ATTACHMENTS)),
})

/** Bound a whole batch, including PDFs with several page images. */
export const attachmentBatchError = (attachments: ReadonlyArray<InputAttachment>): string | undefined => {
  if (attachments.length > MAX_INPUT_ATTACHMENTS) return `Attach at most ${MAX_INPUT_ATTACHMENTS} files per message.`
  const parts = attachments.flatMap(attachment => attachment.content)
  if (parts.filter(part => part.type === "image").length > MAX_ATTACHMENT_IMAGES) return `Attach at most ${MAX_ATTACHMENT_IMAGES} images or scanned PDF pages per message.`
  if (parts.reduce((size, part) => size + (part.type === "text" ? part.text.length : part.data_url.length), 0) > MAX_ATTACHMENT_PAYLOAD) return "The attachments are too large for one message. Send fewer files."
  if (parts.reduce((size, part) => size + (part.type === "text" ? part.text.length : 0), 0) > MAX_ATTACHMENT_TEXT) return "The attached documents contain too much text for one message. Send a smaller excerpt."
  return undefined
}
