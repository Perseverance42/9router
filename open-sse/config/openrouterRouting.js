export const OPENROUTER_QUANTIZATIONS = [
  "int4", "int8", "fp4", "mxfp4", "nvfp4", "fp6", "fp8", "mxfp8",
  "fp16", "bf16", "fp32", "unknown",
];

export const OPENROUTER_PRECISION_PRESETS = {
  unrestricted: [],
  eightBit: ["int8", "fp8", "fp16", "bf16", "fp32"],
  sixteenBit: ["fp16", "bf16", "fp32"],
};

export const OPENROUTER_QUANTIZATION_FAMILIES = {
  fp4: ["fp4", "mxfp4", "nvfp4"],
  fp8: ["fp8", "mxfp8"],
};

export const OPENROUTER_ROUTING_ENDPOINTS = {
  completion: { precision: true, zdr: true },
  embedding: { precision: true, zdr: true },
  systemone: { precision: true, zdr: true },
  image: { exception: "allowImageWithoutZdr", reason: "ZDR enforcement for dedicated image generation is not verified" },
  video: { exception: "allowVideoWithoutZdr", reason: "OpenRouter video generation is not eligible for ZDR" },
};
