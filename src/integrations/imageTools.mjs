export function registerImageTools(registry, imageGenerator) {
  if (!registry || !imageGenerator) {
    throw new TypeError("Image tools require a registry and image generator.");
  }

  registry.register({
    id: "generate_image",
    name: "Generate visual asset",
    description: "Generate a visual asset, pixel illustration, or conceptual artwork from a descriptive text prompt.",
    scope: "image:generate",
    risk: "read",
    trust: "internal",
    network: true,
    externalAction: false,
    untrustedOutput: false,
    tags: ["image", "visual", "art", "pixel", "asset", "generate", "draw"],
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: 1000 },
        style: { type: "string", maxLength: 80 }
      },
      required: ["prompt"],
      additionalProperties: false
    },
    handler: async ({ prompt, style = "pixel-art" }) => {
      const result = await imageGenerator.generate({ prompt, style });
      return {
        id: result.id,
        filename: result.filename,
        url: result.url,
        prompt: result.prompt,
        provider: result.provider,
        mimeType: result.mimeType,
        markdown: `![${result.prompt}](${result.url})`
      };
    }
  });

  return registry;
}
