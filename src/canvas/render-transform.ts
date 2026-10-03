import { StreamEngineError } from "../stream/stream-errors";
import type { RenderFitMode, RenderTransform } from "./render-types";

export function calculateRenderTransform(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  fitMode: RenderFitMode,
): RenderTransform {
  const dimensions = [sourceWidth, sourceHeight, targetWidth, targetHeight];
  if (dimensions.some((dimension) => !Number.isFinite(dimension) || dimension <= 0)) {
    throw new StreamEngineError("STREAM_INVALID_CONFIG", "Source and target dimensions must be finite positive numbers.", {
      sourceWidth,
      sourceHeight,
      targetWidth,
      targetHeight,
    });
  }
  if (fitMode !== "cover" && fitMode !== "contain") {
    throw new StreamEngineError("STREAM_INVALID_CONFIG", "Fit mode must be cover or contain.", { fitMode });
  }

  if (fitMode === "contain") {
    const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
    const width = sourceWidth * scale;
    const height = sourceHeight * scale;
    return {
      x: (targetWidth - width) / 2,
      y: (targetHeight - height) / 2,
      width,
      height,
      sourceX: 0,
      sourceY: 0,
      sourceWidth,
      sourceHeight,
    };
  }

  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = targetWidth / targetHeight;
  let cropX = 0;
  let cropY = 0;
  let cropWidth = sourceWidth;
  let cropHeight = sourceHeight;

  if (sourceAspect > targetAspect) {
    cropWidth = sourceHeight * targetAspect;
    cropX = (sourceWidth - cropWidth) / 2;
  } else if (sourceAspect < targetAspect) {
    cropHeight = sourceWidth / targetAspect;
    cropY = (sourceHeight - cropHeight) / 2;
  }

  return {
    x: 0,
    y: 0,
    width: targetWidth,
    height: targetHeight,
    sourceX: cropX,
    sourceY: cropY,
    sourceWidth: cropWidth,
    sourceHeight: cropHeight,
  };
}
