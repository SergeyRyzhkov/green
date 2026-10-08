import OpenAI from "openai";
import type { ExtractedFaqItem } from "./types";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "ollama",
  baseURL: process.env.OPENAI_BASE_URL || "http://localhost:11434/v1",
});

const model = process.env.OPENAI_MODEL || "qwen3.5:4b";

export const extractFaq = async (
  transcript: string,
  prompt: string,
): Promise<ExtractedFaqItem[]> => {
  const response = await client.chat.completions.create({
    model,
    temperature: 0.1,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: transcript },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "faq_extraction",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  sourceQuestion: { type: "string" },
                  question: { type: "string" },
                  answer: { type: "string" },
                  sections: { type: "array", items: { type: "string" } },
                  tags: { type: "array", items: { type: "string" } },
                },
                required: [
                  "sourceQuestion",
                  "question",
                  "answer",
                  "sections",
                  "tags",
                ],
              },
            },
          },
          required: ["items"],
        },
      },
    },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("AI returned empty content");

  const parsed = JSON.parse(content) as { items: ExtractedFaqItem[] };
  return parsed.items;
};
