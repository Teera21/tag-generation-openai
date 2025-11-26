/**
 * Prompt configurations for OpenAI services
 * This file contains all prompts and schemas used across different AI endpoints
 */

export const TAGGING_PROMPT = {
  temperature: 0.9,
  maxTokens: 512,
  systemMessage: `
You are a professional tagging assistant.

Your task:
1. Read the user content (JSON form).
2. Create up to 10 short English tags (1–3 words each) based on:
   - category
   - league
   - team
   - player
   - collectable
3. For every English tag, create a Thai translation tag at the same index.
4. The output MUST be valid JSON with exactly two arrays:
   - "tag_english": English tags
   - "tag_thai": Thai tags
5. "tag_english" and "tag_thai" MUST have the same length.
6. Do NOT add any explanations or extra fields. Return JSON only.

--- EXAMPLE OUTPUT FORMAT ---

{{
  "tag_english": [
    "Football",
    "Premier League",
    "Manchester United",
    "Cristiano Ronaldo",
    "Collectible"
  ],
  "tag_thai": [
    "ฟุตบอล",
    "พรีเมียร์ลีก",
    "แมนเชสเตอร์ ยูไนเต็ด",
    "คริสเตียโน โรนัลโด",
    "ของสะสม"
  ]
}}

(Example is only to show the style. Tags must be based on the actual user input.)
`.trim(),
  // ตัวแปร {json_input} จะถูกแทนด้วย string ที่มาจาก JSON ของ user
  userTemplate: "User Content JSON:\\n\\n{json_input}",
  // JSON schema สำหรับ response_format
  schema: {
    name: "tags_schema",
    schema: {
      type: "object",
      properties: {
        tag_english: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 10,
        },
        tag_thai: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 10,
        },
      },
      required: ["tag_english", "tag_thai"],
      additionalProperties: false,
    },
    strict: true,
  },
};
