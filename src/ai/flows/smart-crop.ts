
'use server';
/**
 * @fileOverview An AI-powered image cropping tool.
 * The AI identifies the primary subject's tight bounding box.
 * Code then adds margins, adjusts for aspect ratio, and clamps to image boundaries.
 *
 * - smartCrop - A function that returns cropping parameters.
 * - SmartCropInput - The input type for the smartCrop function.
 * - SmartCropParameters - The output type (cropping parameters) for the smartCrop function.
 */

import {ai} from '@/ai/genkit';
import {z as z_} from 'genkit'; // Renamed to avoid conflict with global z

// Schema for AI's direct output: the tight bounding box of the subject
const AISubjectBoxSchema = z_.object({
  subjectX: z_.number().describe("The x-coordinate of the top-left corner of the tight bounding box around the primary subject. Must be an integer."),
  subjectY: z_.number().describe("The y-coordinate of the top-left corner of the tight bounding box around the primary subject. Must be an integer."),
  subjectWidth: z_.number().describe("The width of the tight bounding box around the primary subject. Must be an integer and positive."),
  subjectHeight: z_.number().describe("The height of the tight bounding box around the primary subject. Must be an integer and positive."),
});

const SmartCropInputSchema = z_.object({
  photoDataUri: z_
    .string()
    .describe(
      "A photo to crop, as a data URI that must include a MIME type and use Base64 encoding. Expected format: 'data:<mimetype>;base64,<encoded_data>'."
    ),
  width: z_.number().describe('The desired final width of the cropped image.'),
  height: z_.number().describe('The desired final height of the cropped image.'),
  originalImageWidth: z_.number().describe('The original width of the image being cropped.'),
  originalImageHeight: z_.number().describe('The original height of the image being cropped.'),
});
export type SmartCropInput = z_.infer<typeof SmartCropInputSchema>;

const SmartCropParametersSchema = z_.object({
  sourceX: z_.number().describe("The x-coordinate of the top-left corner of the final crop rectangle in the original image. Must be an integer."),
  sourceY: z_.number().describe("The y-coordinate of the top-left corner of the final crop rectangle in the original image. Must be an integer."),
  sourceWidth: z_.number().describe("The width of the final crop rectangle in the original image. Must be an integer and positive."),
  sourceHeight: z_.number().describe("The height of the final crop rectangle in the original image. Must be an integer and positive."),
});
export type SmartCropParameters = z_.infer<typeof SmartCropParametersSchema>;

export async function smartCrop(input: SmartCropInput): Promise<SmartCropParameters> {
  return smartCropFlow(input);
}

const determineSubjectBoxPrompt = ai.definePrompt({
  name: 'determineSubjectBoxPrompt',
  input: {schema: SmartCropInputSchema}, // Still pass full input for context
  output: {schema: AISubjectBoxSchema},
  prompt: `You are an expert AI image analysis assistant. Your task is to identify the **tightest possible rectangular bounding box** that precisely encloses the primary subject(s) in the provided image.

Prioritization for identifying the primary subject:
1.  Human Faces: If faces are present, the tight bounding box should snugly enclose them. **Ensure this box is well-centered on the face and captures its key features (eyes, nose, mouth).**
2.  Human Figures: If no faces, or as a secondary priority, identify full human figures.
3.  Other Salient Subjects: If no humans, identify other main subjects (e.g., pets, landmarks, key objects).

Original image dimensions: {{originalImageWidth}}w x {{originalImageHeight}}h pixels.
The final cropped image will be resized to {{width}}w x {{height}}h pixels by the system *after* you provide the tight subject box.

Your output (subjectX, subjectY, subjectWidth, subjectHeight) defines this tight bounding box in the original image.
- All parameter values MUST be integers.
- subjectWidth and subjectHeight MUST be greater than 0.
- The origin (0,0) is the top-left of the image.
- The rectangle (subjectX, subjectY, subjectWidth, subjectHeight) must be entirely within the original image's dimensions.

The system will later add margins to your suggested tight box and then adjust it to fit the final target aspect ratio. Your primary job is to accurately identify the core subject's tightest boundaries.

Image for analysis:
{{media url=photoDataUri}}

Return ONLY the JSON object with integer values for subjectX, subjectY, subjectWidth, and subjectHeight.
Example output: { "subjectX": 200, "subjectY": 100, "subjectWidth": 150, "subjectHeight": 220 }
`,
});

const smartCropFlow = ai.defineFlow(
  {
    name: 'smartCropFlow',
    inputSchema: SmartCropInputSchema,
    outputSchema: SmartCropParametersSchema,
  },
  async (input): Promise<SmartCropParameters> => {
    if (input.width <= 0 || input.height <= 0) {
      throw new Error("Target width and height must be positive numbers.");
    }
    if (input.originalImageWidth <= 0 || input.originalImageHeight <= 0) {
        throw new Error("Original image width and height must be positive numbers.");
    }

    const {output: aiSubjectBox} = await determineSubjectBoxPrompt(input);

    const useFallback = (reason: string): SmartCropParameters => {
        console.warn(`SmartCrop Fallback: ${reason}. AI Output: ${JSON.stringify(aiSubjectBox || 'N/A')}, Input: ${JSON.stringify(input)}`);
        let fallbackWidth, fallbackHeight;
        const targetAspectRatio = input.width / input.height;
        if (input.originalImageWidth / targetAspectRatio <= input.originalImageHeight) {
            fallbackWidth = input.originalImageWidth;
            fallbackHeight = Math.round(fallbackWidth / targetAspectRatio);
        } else {
            fallbackHeight = input.originalImageHeight;
            fallbackWidth = Math.round(fallbackHeight * targetAspectRatio);
        }
        return {
            sourceX: Math.max(0, Math.round((input.originalImageWidth - fallbackWidth) / 2)),
            sourceY: Math.max(0, Math.round((input.originalImageHeight - fallbackHeight) / 2)),
            sourceWidth: Math.max(1, fallbackWidth),
            sourceHeight: Math.max(1, fallbackHeight),
        };
    };

    if (!aiSubjectBox || aiSubjectBox.subjectWidth <= 0 || aiSubjectBox.subjectHeight <= 0) {
      return useFallback(`AI failed to determine a valid subject box or returned non-positive dimensions.`);
    }

    let { subjectX, subjectY, subjectWidth, subjectHeight } = aiSubjectBox;
    subjectX = Math.round(subjectX);
    subjectY = Math.round(subjectY);
    subjectWidth = Math.round(subjectWidth);
    subjectHeight = Math.round(subjectHeight);

    // 1. Clamp AI's tight subject box to image boundaries (this becomes clampedSubjectBox)
    let clampedSubjectX = Math.max(0, subjectX);
    let clampedSubjectY = Math.max(0, subjectY);
    let clampedSubjectWidth = Math.min(subjectWidth, input.originalImageWidth - clampedSubjectX);
    clampedSubjectWidth = Math.max(1, clampedSubjectWidth); // Ensure at least 1px, avoid non-positive after min
    let clampedSubjectHeight = Math.min(subjectHeight, input.originalImageHeight - clampedSubjectY);
    clampedSubjectHeight = Math.max(1, clampedSubjectHeight); // Ensure at least 1px

    if (clampedSubjectWidth <= 0 || clampedSubjectHeight <= 0) { // Re-check after ensuring positivity
        return useFallback(`AI's subject box became invalid after initial clamping (w:${clampedSubjectWidth}, h:${clampedSubjectHeight})`);
    }

    // 2. Define desired content area based on clamped subject and MARGIN_EXPANSION_FACTOR
    const MARGIN_EXPANSION_FACTOR = 2.0; // Increased from 1.0
    const desiredContentWidth = Math.round(clampedSubjectWidth * (1 + MARGIN_EXPANSION_FACTOR));
    const desiredContentHeight = Math.round(clampedSubjectHeight * (1 + MARGIN_EXPANSION_FACTOR));

    // 3. Determine final crop dimensions (finalWidth, finalHeight) to hold desired content area at target aspect ratio
    const targetAspectRatio = input.width / input.height;
    let finalWidth, finalHeight;

    if (desiredContentWidth / targetAspectRatio >= desiredContentHeight) {
        finalWidth = desiredContentWidth;
        finalHeight = Math.round(finalWidth / targetAspectRatio);
    } else {
        finalHeight = desiredContentHeight;
        finalWidth = Math.round(finalHeight * targetAspectRatio);
    }

    finalWidth = Math.max(1, finalWidth);
    finalHeight = Math.max(1, finalHeight);

    // 4. Calculate center of the CLAMPED subject box
    const clampedSubjectCenterX = clampedSubjectX + clampedSubjectWidth / 2;
    const clampedSubjectCenterY = clampedSubjectY + clampedSubjectHeight / 2;

    // 5. Initially position the final crop box (finalX, finalY) centered around the clamped subject's center
    let finalX = Math.round(clampedSubjectCenterX - finalWidth / 2);
    let finalY = Math.round(clampedSubjectCenterY - finalHeight / 2);
    
    // 6. Rigorously clamp the final crop box to image boundaries
    // First, adjust dimensions if they exceed original image, maintaining aspect ratio and subject centering
    if (finalWidth > input.originalImageWidth) {
        finalWidth = input.originalImageWidth;
        finalHeight = Math.round(finalWidth / targetAspectRatio);
        finalX = 0; // Crop is full width
        finalY = Math.round(clampedSubjectCenterY - finalHeight / 2); // Recenter Y
    }
    // Check height *after* width adjustment, as width adjustment might change height
    if (finalHeight > input.originalImageHeight) {
        finalHeight = input.originalImageHeight;
        finalWidth = Math.round(finalHeight * targetAspectRatio);
        finalY = 0; // Crop is full height
        finalX = Math.round(clampedSubjectCenterX - finalWidth / 2); // Recenter X
        
        // If width became too large again due to height clamping (e.g. tall narrow target on wide short image)
        if (finalWidth > input.originalImageWidth) {
            finalWidth = input.originalImageWidth;
            finalHeight = Math.round(finalWidth / targetAspectRatio); // Recalculate height
            finalX = 0;
            finalY = Math.round(clampedSubjectCenterY - finalHeight / 2); // Recenter Y again
        }
    }
    
    // Now, clamp the position (X, Y) of the (potentially resized) crop box
    finalX = Math.max(0, finalX);
    finalY = Math.max(0, finalY);

    // Ensure the crop box does not extend beyond the right or bottom edges
    // by adjusting X and Y if necessary.
    if (finalX + finalWidth > input.originalImageWidth) {
        finalX = input.originalImageWidth - finalWidth;
    }
    if (finalY + finalHeight > input.originalImageHeight) {
        finalY = input.originalImageHeight - finalHeight;
    }

    // After all adjustments, ensure X and Y are not negative (can happen if width/height became full image size)
    finalX = Math.max(0, Math.round(finalX));
    finalY = Math.max(0, Math.round(finalY));
    
    // Final pass on width/height to ensure they respect the clamped X/Y and are at least 1px.
    // This also handles cases where finalX/finalY clamping might require width/height adjustment.
    finalWidth = Math.max(1, Math.round(Math.min(finalWidth, input.originalImageWidth - finalX)));
    finalHeight = Math.max(1, Math.round(Math.min(finalHeight, input.originalImageHeight - finalY)));


    // Sanity check results
    if (finalWidth <= 0 || finalHeight <= 0) {
        return useFallback(`Final parameters resulted in non-positive dimensions after all clamping. AI: ${JSON.stringify(aiSubjectBox)}, ClampedSubject: ${JSON.stringify({clampedSubjectX, clampedSubjectY, clampedSubjectWidth, clampedSubjectHeight})}`);
    }

    const resultAspectRatio = finalWidth / finalHeight;
    if (Math.abs(resultAspectRatio - targetAspectRatio) > 0.02) { 
        // If aspect ratio is still off, something went significantly wrong, fallback.
        // This threshold allows for minor floating point inaccuracies.
        return useFallback(
            `Final aspect ratio (${resultAspectRatio.toFixed(2)}) differs too much from target (${targetAspectRatio.toFixed(2)}) ` +
            `after all clamping. AI: ${JSON.stringify(aiSubjectBox)}, Final: ${JSON.stringify({sourceX: finalX, sourceY: finalY, sourceWidth: finalWidth, sourceHeight: finalHeight})}`
        );
    }

    return {
      sourceX: finalX,
      sourceY: finalY,
      sourceWidth: finalWidth,
      sourceHeight: finalHeight,
    };
  }
);
    
