
"use client";

import type { ChangeEvent } from "react";
import React, { useState, useRef, useEffect, useCallback } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import NextImage from "next/image";
import { UploadCloud, Scissors, Download, Loader2, Image as ImageIcon, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { smartCrop, type SmartCropParameters } from "@/ai/flows/smart-crop";

const dimensionSchema = z.object({
  width: z.coerce.number().min(10, "Min 10px").max(4000, "Max 4000px").default(600),
  height: z.coerce.number().min(10, "Min 10px").max(4000, "Max 4000px").default(400),
});

type DimensionFormData = z.infer<typeof dimensionSchema>;

const LOCAL_STORAGE_WIDTH_KEY = "smartCropClient_lastWidth";
const LOCAL_STORAGE_HEIGHT_KEY = "smartCropClient_lastHeight";

interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'w' | 'e';

interface DisplayDimensions {
  visualImageWidth: number;
  visualImageHeight: number;
  imageOffsetXInContainer: number;
  imageOffsetYInContainer: number;
  containerWidth: number;
  containerHeight: number;
}

const minAllowedSizePx = 20;
const DEBOUNCE_DELAY = 750;

export default function SmartCropClient() {
  const [originalImageFile, setOriginalImageFile] = useState<File | null>(null);
  const [originalPreview, setOriginalPreview] = useState<string | null>(null);
  const [originalImageDimensions, setOriginalImageDimensions] = useState<{width: number, height: number} | null>(null);
  
  const [croppedPreview, setCroppedPreview] = useState<string | null>(null);
  const [isLoadingAiSuggestion, setIsLoadingAiSuggestion] = useState(false);
  const [isCropping, setIsCropping] = useState(false);
  const [isDraggingUpload, setIsDraggingUpload] = useState(false);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageContainerRef = useRef<HTMLDivElement>(null);

  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const [isDraggingRect, setIsDraggingRect] = useState(false);
  const [isResizingRect, setIsResizingRect] = useState<ResizeHandle | null>(null);
  const [dragStartOffset, setDragStartOffset] = useState<{x: number, y: number}>({ x: 0, y: 0 });

  const [suggestedAiParams, setSuggestedAiParams] = useState<SmartCropParameters | null>(null);
  const [isVisualImageReady, setIsVisualImageReady] = useState(false);
  const [showUpscalingWarning, setShowUpscalingWarning] = useState(false);
  const [userHasInteracted, setUserHasInteracted] = useState(false);

  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const latestFetchTimestampRef = useRef<number>(0);
  
  const prevOriginalPreviewRef = useRef<string | null>(null);
  const prevSuggestedAiParamsRef = useRef<SmartCropParameters | null | undefined>(undefined);


  const { toast } = useToast();

  const form = useForm<DimensionFormData>({
    resolver: zodResolver(dimensionSchema),
    defaultValues: { width: 600, height: 400 },
  });

  const targetWidth = form.watch('width');
  const targetHeight = form.watch('height');
  const targetAspectRatio = (targetWidth > 0 && targetHeight > 0) ? targetWidth / targetHeight : 3 / 2;
  

  useEffect(() => {
    let widthToSet = 600;
    let heightToSet = 400;
    if (typeof window !== "undefined") {
        const savedWidthStr = localStorage.getItem(LOCAL_STORAGE_WIDTH_KEY);
        const savedHeightStr = localStorage.getItem(LOCAL_STORAGE_HEIGHT_KEY);

        if (savedWidthStr) {
            const parsedWidth = parseInt(savedWidthStr, 10);
            if (!isNaN(parsedWidth) && parsedWidth >= 10 && parsedWidth <= 4000) widthToSet = parsedWidth;
        }
        if (savedHeightStr) {
            const parsedHeight = parseInt(savedHeightStr, 10);
            if (!isNaN(parsedHeight) && parsedHeight >= 10 && parsedHeight <= 4000) heightToSet = parsedHeight;
        }
    }
    form.reset({ width: widthToSet, height: heightToSet });
  }, [form]);

  const getDisplayDimensions = useCallback((): DisplayDimensions | null => {
    if (!imageContainerRef.current) return null;
    const imgElement = imageContainerRef.current.querySelector('img');
    if (!imgElement || !originalImageDimensions) return null;

    const containerElement = imageContainerRef.current;
    const containerRect = containerElement.getBoundingClientRect();
    
    const visualImageWidth = imgElement.clientWidth;
    const visualImageHeight = imgElement.clientHeight;

    if (visualImageWidth === 0 || visualImageHeight === 0) {
        return null;
    }
    
    // Calculate offset of the image within its container (imageContainerRef)
    // This accounts for any padding/border on the container or if the image is smaller than container
    const imgRect = imgElement.getBoundingClientRect();
    const imageOffsetXInContainer = Math.round(imgRect.left - containerRect.left);
    const imageOffsetYInContainer = Math.round(imgRect.top - containerRect.top);
    
    return {
      visualImageWidth,
      visualImageHeight,
      imageOffsetXInContainer,
      imageOffsetYInContainer,
      containerWidth: containerElement.clientWidth, // width of imageContainerRef
      containerHeight: containerElement.clientHeight, // height of imageContainerRef
    };
  }, [originalImageDimensions]);


  const applyCropRectConstraints = useCallback((
    rectToConstrain: CropRect,
    visualImgWidth: number, 
    visualImgHeight: number, 
    aspectRatio: number,
  ): CropRect => {
    let { x, y, width, height } = { ...rectToConstrain };

    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    
    let minWidthApplied = minAllowedSizePx;
    let minHeightApplied = Math.round(minAllowedSizePx / aspectRatio);

    if (minHeightApplied < minAllowedSizePx) {
        minHeightApplied = minAllowedSizePx;
        minWidthApplied = Math.round(minAllowedSizePx * aspectRatio);
    } else if (minWidthApplied < minAllowedSizePx) {
        minWidthApplied = minAllowedSizePx;
        minHeightApplied = Math.round(minWidthApplied / aspectRatio);
    }
    
    // Enforce minimum size while maintaining aspect ratio
    if (width < minWidthApplied || height < minHeightApplied) {
        if (width / aspectRatio >= height) { // Width is the dominant factor for min size or incoming rect is wider
            width = minWidthApplied;
            height = Math.round(width / aspectRatio);
        } else { // Height is the dominant factor
            height = minHeightApplied;
            width = Math.round(height * aspectRatio);
        }
    }
    
    // Enforce maximum size (image boundaries) while maintaining aspect ratio
    if (width > visualImgWidth) {
        width = visualImgWidth;
        height = Math.round(width / aspectRatio);
    }
    if (height > visualImgHeight) { // Check height after width adjustment
        height = visualImgHeight;
        width = Math.round(height * aspectRatio);
    }
     // Second pass to ensure aspect ratio didn't push other dim out of bounds
     if (width > visualImgWidth) { 
        width = visualImgWidth;
        height = Math.round(width / aspectRatio);
    }
     if (height > visualImgHeight) { 
        height = visualImgHeight;
        width = Math.round(height * aspectRatio);
    }


    // Clamp position to keep the rectangle within visual image bounds (0,0 to visualImgWidth, visualImgHeight)
    x = Math.max(0, Math.min(Math.round(x), visualImgWidth - width));
    y = Math.max(0, Math.min(Math.round(y), visualImgHeight - height));

    return { x, y, width: Math.max(1, width), height: Math.max(1, height) };
  }, []);


  const calculateNewCropRect = useCallback((aiParams: SmartCropParameters | null): CropRect | null => {
    const displayDims = getDisplayDimensions();
    if (!isVisualImageReady || !originalImageDimensions || !form.formState.isValid || !displayDims) {
      return null;
    }
    
    const { visualImageWidth, visualImageHeight } = displayDims;
     if (visualImageWidth === 0 || visualImageHeight === 0) {
      return null;
    }
    
    const currentTargetAspectRatio = targetAspectRatio; 

    let newCalculatedRect: CropRect;
    if (aiParams && aiParams.sourceWidth > 0 && aiParams.sourceHeight > 0) {
      const scaleToVisualX = visualImageWidth / originalImageDimensions.width;
      const scaleToVisualY = visualImageHeight / originalImageDimensions.height;
      
      newCalculatedRect = {
        x: Math.round(aiParams.sourceX * scaleToVisualX),
        y: Math.round(aiParams.sourceY * scaleToVisualY),
        width: Math.round(aiParams.sourceWidth * scaleToVisualX),
        height: Math.round(aiParams.sourceHeight * scaleToVisualY),
      };
    } else { 
      // Default crop if no AI params: 80% of the smaller dimension, aspect ratio correct, centered
      let defaultWidth = visualImageWidth * 0.8;
      let defaultHeight = defaultWidth / currentTargetAspectRatio;

      if (defaultHeight > visualImageHeight * 0.8) {
        defaultHeight = visualImageHeight * 0.8;
        defaultWidth = defaultHeight * currentTargetAspectRatio;
      }
      // Ensure width is also within 80% if height adjustment pushed it out
      if (defaultWidth > visualImageWidth * 0.8) { 
        defaultWidth = visualImageWidth * 0.8;
        defaultHeight = defaultWidth / currentTargetAspectRatio;
      }
      newCalculatedRect = {
        x: (visualImageWidth - defaultWidth) / 2,
        y: (visualImageHeight - defaultHeight) / 2,
        width: defaultWidth,
        height: defaultHeight,
      };
    }
    return applyCropRectConstraints(newCalculatedRect, visualImageWidth, visualImageHeight, currentTargetAspectRatio);
  }, [isVisualImageReady, originalImageDimensions, getDisplayDimensions, applyCropRectConstraints, form.formState.isValid, targetAspectRatio]);


  const fetchAiSuggestion = useCallback(async () => {
    if (!originalPreview || !originalImageDimensions || targetWidth <=0 || targetHeight <=0 || !form.formState.isValid) {
        setSuggestedAiParams(null); 
        return;
    }

    const currentFetchTimestamp = Date.now();
    latestFetchTimestampRef.current = currentFetchTimestamp;
    setIsLoadingAiSuggestion(true);
    
    try {
      const aiParamsResult = await smartCrop({
        photoDataUri: originalPreview,
        width: Number(targetWidth),
        height: Number(targetHeight),
        originalImageWidth: Number(originalImageDimensions.width),
        originalImageHeight: Number(originalImageDimensions.height),
      });
      if (currentFetchTimestamp === latestFetchTimestampRef.current) {
        setSuggestedAiParams(aiParamsResult);
      } else {
        console.log("SmartCrop: Stale AI suggestion ignored due to newer request.");
      }
    } catch (error) {
      console.error("Error fetching AI crop suggestion:", error);
      toast({ variant: "destructive", title: "AI Suggestion Failed", description: (error as Error).message });
      if (currentFetchTimestamp === latestFetchTimestampRef.current) {
        setSuggestedAiParams(null); // Clear if this was the latest attempt and it failed
      }
    } finally {
      if (currentFetchTimestamp === latestFetchTimestampRef.current) {
        setIsLoadingAiSuggestion(false);
      }
    }
  }, [originalPreview, originalImageDimensions, targetWidth, targetHeight, toast, form.formState.isValid]);


  // Effect 1: New image detection and AI suggestion trigger
  useEffect(() => {
    if (originalPreview && originalImageDimensions) {
      // Only fetch if the preview URL has actually changed from the last processed one
      if (originalPreview !== prevOriginalPreviewRef.current) {
          console.log("Effect 1: New image detected, settings cropRect to null and fetching AI.");
          setCropRect(null); // Clear current crop rect for new image
          setIsVisualImageReady(false); // Image needs to load visually
          // prevSuggestedAiParamsRef.current = undefined; // Mark old AI params as stale
          fetchAiSuggestion(); // Fetch AI for the new image
      }
    } else if (!originalPreview && prevOriginalPreviewRef.current !== null) { // Image cleared
      setCropRect(null);
      setIsVisualImageReady(false);
      setSuggestedAiParams(null);
      setOriginalImageDimensions(null); // Also clear dimensions if image is gone
      // prevSuggestedAiParamsRef.current = undefined;
    }
    // This effect should primarily react to new image data, not other state changes for the same image
  }, [originalPreview, originalImageDimensions, fetchAiSuggestion]);


  // Effect 2: Main cropRect calculation, driven by AI results or fallback.
  // This effect applies the AI suggestion or a default crop.
  useEffect(() => {
    if (!isVisualImageReady || !originalImageDimensions || isLoadingAiSuggestion || isDraggingRect || isResizingRect || !originalPreview) {
      // If AI is loading and we have an image, ensure cropRect is null to show loader
      if(isLoadingAiSuggestion && cropRect !== null && !isDraggingRect && !isResizingRect && originalPreview) {
         setCropRect(null); 
      }
      return;
    }

    const imageJustChanged = originalPreview !== prevOriginalPreviewRef.current;
    // Check if AI params are new *for the current image context* OR if it's an initial setup for this image
    const newAiParamsAvailableAndNotYetApplied = suggestedAiParams !== prevSuggestedAiParamsRef.current;

    let shouldApplyAiOrDefault = false;
    if (cropRect === null && originalPreview) { // CropRect is null, needs initialization
        shouldApplyAiOrDefault = true;
    } else if (imageJustChanged) { // A completely new image was loaded
        shouldApplyAiOrDefault = true;
        // setUserHasInteracted(false); // Reset interaction state for new image (already in handleFileChange)
    } else if (newAiParamsAvailableAndNotYetApplied && !imageJustChanged && !userHasInteracted) {
        // AI params updated for the *current* image, and user hasn't manually changed crop yet
        shouldApplyAiOrDefault = true;
    }


    if (shouldApplyAiOrDefault) {
      console.log("Effect 2: Applying AI/default crop. UserInteracted:", userHasInteracted, "ImageChanged:", imageJustChanged, "NewAI:", newAiParamsAvailableAndNotYetApplied);
      const newCalculatedRect = calculateNewCropRect(suggestedAiParams);
      if (newCalculatedRect && (cropRect === null ||
          newCalculatedRect.x !== cropRect.x || newCalculatedRect.y !== cropRect.y ||
          newCalculatedRect.width !== cropRect.width || newCalculatedRect.height !== cropRect.height)
      ) {
          setCropRect(newCalculatedRect);
      } else if (!newCalculatedRect && cropRect !== null) { // If calculation fails, clear rect
          setCropRect(null);
      }
      // Mark this preview and these AI params as "processed" for this effect's run
      if (originalPreview) prevOriginalPreviewRef.current = originalPreview;
      prevSuggestedAiParamsRef.current = suggestedAiParams;
    }

  }, [
    isVisualImageReady,
    originalImageDimensions,
    isLoadingAiSuggestion,
    suggestedAiParams,
    calculateNewCropRect,
    originalPreview, // Key trigger for "new image context"
    isDraggingRect, 
    isResizingRect,
    userHasInteracted, // To allow AI to apply if user hasn't touched this image's crop
    cropRect // Needed to compare and prevent unnecessary sets
  ]);


  // Effect 3: Debounced AI re-fetch on target dimension changes
  useEffect(() => {
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }

    if (originalPreview && originalImageDimensions && targetWidth > 0 && targetHeight > 0 && form.formState.isValid) {
      debounceTimeoutRef.current = setTimeout(() => {
        // Check conditions again inside timeout, as state might have changed
        if (originalPreview && originalImageDimensions && targetWidth > 0 && targetHeight > 0 && form.formState.isValid &&
            !isDraggingRect && !isResizingRect // Don't fetch if user is currently interacting
        ) {
             console.log("Effect 3: Debounce fired, clearing cropRect, resetting interaction, and fetching AI for new dimensions.");
             setCropRect(null); // Clear current crop to show loading for new AI suggestion
             // prevSuggestedAiParamsRef.current = undefined; // Mark that the next AI params will be "new"
             setUserHasInteracted(false); // New dimensions from input fields mean AI suggestion should apply
             fetchAiSuggestion();
        }
      }, DEBOUNCE_DELAY);
    }

    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, [targetWidth, targetHeight, originalPreview, originalImageDimensions, form.formState.isValid, fetchAiSuggestion]);


  // Effect 4: Calculate if upscaling warning is needed
  useEffect(() => {
    if (!isVisualImageReady) { 
      if (showUpscalingWarning) setShowUpscalingWarning(false); 
      return;
    }

    const displayDims = getDisplayDimensions();
    let needsWarning = false;

    if (cropRect && originalImageDimensions && displayDims && targetWidth > 0 && targetHeight > 0) {
      const { visualImageWidth, visualImageHeight } = displayDims;
      // Ensure no division by zero if visual dimensions are momentarily zero
      if (visualImageWidth > 0 && visualImageHeight > 0 && originalImageDimensions.width > 0 && originalImageDimensions.height > 0) {
        const scaleX = originalImageDimensions.width / visualImageWidth;
        const scaleY = originalImageDimensions.height / visualImageHeight;
        
        // cropRect.width/height are relative to visual image
        const sourceCropWidth = Math.round(cropRect.width * scaleX);
        const sourceCropHeight = Math.round(cropRect.height * scaleY);

        needsWarning = sourceCropWidth < targetWidth || sourceCropHeight < targetHeight;
      }
    }
    
    if (showUpscalingWarning !== needsWarning) {
        setShowUpscalingWarning(needsWarning);
    }
  }, [cropRect, targetWidth, targetHeight, originalImageDimensions, getDisplayDimensions, showUpscalingWarning, isVisualImageReady]);


  // Effect 5: Upscaling Warning Toast
  const prevShowUpscalingWarningRef = useRef<boolean>(false);
  useEffect(() => {
    if (showUpscalingWarning && !prevShowUpscalingWarningRef.current) {
      toast({
        title: "Image Quality Warning",
        description: "The selected crop area is smaller than the target dimensions. The final image may be upscaled and lose quality.",
        variant: "destructive",
        duration: 5000,
      });
    }
    prevShowUpscalingWarningRef.current = showUpscalingWarning;
  }, [showUpscalingWarning, toast]);
  

  const handleFileChange = useCallback((file: File | null) => {
    // Reset all image-related state for the new file
    setOriginalImageFile(null); // Set early so UI can react
    setOriginalPreview(null);
    setOriginalImageDimensions(null);
    setCroppedPreview(null);
    setCropRect(null); // Critical: ensure cropRect is null for new image
    setIsVisualImageReady(false);
    setSuggestedAiParams(null); // Clear previous AI suggestions
    setIsLoadingAiSuggestion(false); // Reset loading state
    if(showUpscalingWarning) setShowUpscalingWarning(false);
    setUserHasInteracted(false); // New image, so user interaction is reset
    
    prevOriginalPreviewRef.current = null; // Mark that the new preview will indeed be "new"
    prevSuggestedAiParamsRef.current = undefined; // Mark AI params as needing refresh


    if (fileInputRef.current) fileInputRef.current.value = ""; // Clear file input

    if (file && file.type.startsWith("image/")) {
      // setIsLoadingAiSuggestion(true); // This will be set by fetchAiSuggestion
      const reader = new FileReader();
      reader.onloadend = () => {
        if (reader.error) {
          toast({ variant: "destructive", title: "File Read Error", description: reader.error.message || "Could not read the selected file."});
          // Ensure full reset on error
          setOriginalPreview(null); setOriginalImageDimensions(null); setOriginalImageFile(null);
          setCroppedPreview(null); setCropRect(null); setIsVisualImageReady(false); 
          setSuggestedAiParams(null); setIsLoadingAiSuggestion(false); setShowUpscalingWarning(false);setUserHasInteracted(false);
          prevOriginalPreviewRef.current = null; prevSuggestedAiParamsRef.current = undefined;
          return;
        }
        const dataUrl = reader.result as string;
        
        const img = document.createElement('img');
        img.onload = () => {
          // Only set these *after* img.onload to ensure dimensions are valid
          setOriginalImageFile(file); // Set the file state now that we have dimensions
          setOriginalPreview(dataUrl); // Set preview now, triggers Effect 1
          setOriginalImageDimensions({ width: img.naturalWidth, height: img.naturalHeight });
        };
        img.onerror = () => {
          toast({ variant: "destructive", title: "Image Load Error", description: "Could not decode image or image format is unsupported."});
          setOriginalPreview(null); setOriginalImageDimensions(null); setOriginalImageFile(null);
          setCroppedPreview(null); setCropRect(null); setIsVisualImageReady(false);
          setSuggestedAiParams(null); setIsLoadingAiSuggestion(false); setShowUpscalingWarning(false);setUserHasInteracted(false);
          prevOriginalPreviewRef.current = null; prevSuggestedAiParamsRef.current = undefined;
        };
        img.src = dataUrl; // This triggers img.onload or img.onerror
      };
      reader.onerror = () => { // Error reading the file itself
        toast({ variant: "destructive", title: "File Read Error", description: "Error occurred while reading the file."});
        setOriginalPreview(null); setOriginalImageDimensions(null); setOriginalImageFile(null);
        setCroppedPreview(null); setCropRect(null); setIsVisualImageReady(false); 
        setSuggestedAiParams(null); setIsLoadingAiSuggestion(false); setShowUpscalingWarning(false);setUserHasInteracted(false);
        prevOriginalPreviewRef.current = null; prevSuggestedAiParamsRef.current = undefined;
      };
      reader.readAsDataURL(file);
    } else if (file) {
      toast({ variant: "destructive", title: "Invalid File Type", description: "Please upload an image (JPG, PNG, GIF, WEBP)."});
    }
  }, [toast, showUpscalingWarning]); // showUpscalingWarning was in dep array, seems okay but minor


  const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault(); event.stopPropagation(); setIsDraggingUpload(false);
    if (event.dataTransfer.files && event.dataTransfer.files[0]) {
      handleFileChange(event.dataTransfer.files[0]);
    }
  }, [handleFileChange]);

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault(); event.stopPropagation(); setIsDraggingUpload(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault(); event.stopPropagation(); setIsDraggingUpload(false);
  }, []);


  const onFileSelect = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files[0]) {
      handleFileChange(event.target.files[0]);
    }
    if(event.target) event.target.value = ""; // Reset input value to allow re-selection of same file
  }, [handleFileChange]);

  const performClientSideCrop = useCallback((
    imageSrc: string,
    sourceParams: SmartCropParameters, // These are relative to original image
    outputWidthNum: number,
    outputHeightNum: number
  ): Promise<string> => {
    return new Promise((resolve, reject) => {
      const img = document.createElement('img');
      img.onload = () => {
        if (sourceParams.sourceWidth <= 0 || sourceParams.sourceHeight <= 0) {
            reject(new Error("Invalid crop dimensions: source width or height is zero or negative."));
            return;
        }
        if (outputWidthNum <= 0 || outputHeightNum <= 0) {
            reject(new Error("Invalid output dimensions: width or height is zero or negative."));
            return;
        }

        const canvas = document.createElement('canvas');
        canvas.width = outputWidthNum;
        canvas.height = outputHeightNum;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error("Failed to get canvas context.")); return; }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        try {
            // Draw from original image using sourceParams
            ctx.drawImage(img, sourceParams.sourceX, sourceParams.sourceY, sourceParams.sourceWidth, sourceParams.sourceHeight, 0, 0, outputWidthNum, outputHeightNum);
        } catch (e) {
            reject(new Error(`Canvas drawImage error: ${(e as Error).message}. Source params: ${JSON.stringify(sourceParams)}`));
            return;
        }
        
        try {
            const dataUrl = canvas.toDataURL(originalImageFile?.type === 'image/png' ? 'image/png' : 'image/webp', 0.9); 
            resolve(dataUrl);
        } catch (e) {
            console.warn("Error converting canvas to preferred format, falling back to PNG:", e);
            try { resolve(canvas.toDataURL('image/png', 0.9)); }
            catch (pngError) { reject(new Error("Failed to convert canvas to data URL."));}
        }
      };
      img.onerror = () => { reject(new Error("Error loading image for cropping.")); };
      img.src = imageSrc; // imageSrc is originalPreview (data URL of original image)
    });
  }, [originalImageFile]);

  const onSubmitDimensions = useCallback(async (formData: DimensionFormData) => {
    if (!originalPreview || !originalImageDimensions || !cropRect) {
      toast({ variant: "destructive", title: "Missing Data", description: "Upload image and ensure crop area is set." });
      return;
    }

    const displayDims = getDisplayDimensions();
    if (!displayDims || displayDims.visualImageWidth === 0 || displayDims.visualImageHeight === 0) {
        toast({ variant: "destructive", title: "Layout Error", description: "Cannot determine image display size for crop." });
        return;
    }
    
    const { visualImageWidth, visualImageHeight } = displayDims;

    // cropRect.x, y, width, height are relative to the visual image
    // Convert these visual crop parameters to source parameters relative to original image
    const scaleToOriginalX = originalImageDimensions.width / visualImageWidth;
    const scaleToOriginalY = originalImageDimensions.height / visualImageHeight;

    let sourceParams: SmartCropParameters = {
      sourceX: Math.round(cropRect.x * scaleToOriginalX),
      sourceY: Math.round(cropRect.y * scaleToOriginalY),
      sourceWidth: Math.round(cropRect.width * scaleToOriginalX),
      sourceHeight: Math.round(cropRect.height * scaleToOriginalY),
    };
    
    // Final sanity check and clamping for sourceParams
    const tolerance = 2; // Allow small floating point errors before hard clamp
    if (sourceParams.sourceWidth <= 0 || sourceParams.sourceHeight <= 0 ||
        sourceParams.sourceX < -tolerance || sourceParams.sourceY < -tolerance ||
        sourceParams.sourceX + sourceParams.sourceWidth > originalImageDimensions.width + tolerance ||
        sourceParams.sourceY + sourceParams.sourceHeight > originalImageDimensions.height + tolerance) {
        toast({ variant: "destructive", title: "Invalid Crop Area", description: `Calculated crop area is outside original image bounds. W:${sourceParams.sourceWidth}, H:${sourceParams.sourceHeight}, X:${sourceParams.sourceX}, Y:${sourceParams.sourceY}. Orig Dims: W${originalImageDimensions.width} H${originalImageDimensions.height}` });
        setIsCropping(false); // Ensure this is reset if it was set
        return;
    }
    sourceParams.sourceX = Math.max(0, Math.min(Math.round(sourceParams.sourceX), originalImageDimensions.width - 1));
    sourceParams.sourceY = Math.max(0, Math.min(Math.round(sourceParams.sourceY), originalImageDimensions.height - 1));
    sourceParams.sourceWidth = Math.max(1, Math.min(Math.round(sourceParams.sourceWidth), originalImageDimensions.width - sourceParams.sourceX));
    sourceParams.sourceHeight = Math.max(1, Math.min(Math.round(sourceParams.sourceHeight), originalImageDimensions.height - sourceParams.sourceY));


    if (typeof window !== "undefined") {
        localStorage.setItem(LOCAL_STORAGE_WIDTH_KEY, String(formData.width));
        localStorage.setItem(LOCAL_STORAGE_HEIGHT_KEY, String(formData.height));
    }

    setIsCropping(true); setCroppedPreview(null);

    try {
      const croppedImageUri = await performClientSideCrop(originalPreview, sourceParams, formData.width, formData.height);
      setCroppedPreview(croppedImageUri);
      toast({ title: "Success!", description: "Image cropped successfully." });
    } catch (error) {
      console.error("Error in client-side crop process:", error);
      toast({ variant: "destructive", title: "Cropping Failed", description: (error as Error).message });
    } finally {
      setIsCropping(false);
    }
  }, [originalPreview, originalImageDimensions, cropRect, toast, getDisplayDimensions, performClientSideCrop]); // Removed form from deps

  const handleDownload = useCallback(() => {
    if (!croppedPreview || !originalImageFile || targetWidth <=0 || targetHeight <=0) {
      toast({
        variant: "destructive",
        title: "Download Error",
        description: "Cannot download without an original file, a cropped preview, and valid dimensions.",
      });
      return;
    }
    const link = document.createElement("a");
    link.href = croppedPreview;

    let originalNameWithoutExt = originalImageFile.name;
    const lastDot = originalImageFile.name.lastIndexOf('.');
    if (lastDot !== -1 && lastDot > 0) { // Ensure dot is not the first char
        originalNameWithoutExt = originalImageFile.name.substring(0, lastDot);
    }
    
    const sanitizedBaseName = originalNameWithoutExt.replace(/[^\w.-]/g, '_'); // Allow dots and hyphens

    // Determine extension from data URI
    const fileExtension = croppedPreview.startsWith('data:image/webp') ? 'webp' : (croppedPreview.startsWith('data:image/png') ? 'png' : 'jpg');
    link.download = `${sanitizedBaseName}-${targetWidth}x${targetHeight}.${fileExtension}`;
    
    document.body.appendChild(link); // Required for Firefox
    link.click(); // Programmatically click the link to trigger the download
    document.body.removeChild(link); // Clean up by removing the link
    toast({ title: "Download Started", description: `Image downloading as ${link.download}` });
  }, [croppedPreview, targetWidth, targetHeight, originalImageFile, toast]);

  const handleRectMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!cropRect || !imageContainerRef.current) return;
    
    const displayDims = getDisplayDimensions();
    if (!displayDims) return;
    e.preventDefault(); // Prevent text selection or other default behaviors
    setUserHasInteracted(true);


    const containerRect = imageContainerRef.current.getBoundingClientRect();
    // Mouse position relative to the VISUAL IMAGE's top-left corner
    const mouseX_onImage = e.clientX - containerRect.left - displayDims.imageOffsetXInContainer;
    const mouseY_onImage = e.clientY - containerRect.top - displayDims.imageOffsetYInContainer;

    setDragStartOffset({
      x: mouseX_onImage - cropRect.x, // cropRect.x is already image-relative
      y: mouseY_onImage - cropRect.y,  // cropRect.y is already image-relative
    });
    setIsDraggingRect(true);
  }, [cropRect, getDisplayDimensions]); // Added setUserHasInteracted

  const handleResizeMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>, handle: ResizeHandle) => {
    if (!cropRect || !imageContainerRef.current) return;
    e.preventDefault();
    e.stopPropagation(); // Prevent triggering drag on the main rectangle
    setUserHasInteracted(true);
    setIsResizingRect(handle);
    
    const displayDims = getDisplayDimensions();
    if (!displayDims) return;
    const containerRect = imageContainerRef.current.getBoundingClientRect();
    // Store initial mouse position relative to the VISUAL IMAGE
    const mouseX_onImage = e.clientX - containerRect.left - displayDims.imageOffsetXInContainer;
    const mouseY_onImage = e.clientY - containerRect.top - displayDims.imageOffsetYInContainer;
    setDragStartOffset({ x: mouseX_onImage, y: mouseY_onImage }); 

  }, [cropRect, getDisplayDimensions]); // Added setUserHasInteracted


 const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!cropRect || !imageContainerRef.current || !originalImageDimensions) return;
    if (!isDraggingRect && !isResizingRect) return;

    const displayDims = getDisplayDimensions();
    if (!displayDims || displayDims.visualImageWidth <= 0 || displayDims.visualImageHeight <= 0) return;

    const { visualImageWidth, visualImageHeight, imageOffsetXInContainer, imageOffsetYInContainer } = displayDims;
    const containerRect = imageContainerRef.current.getBoundingClientRect();

    // Mouse position relative to the VISUAL IMAGE's top-left corner
    let mouseX_onImage = e.clientX - containerRect.left - imageOffsetXInContainer;
    let mouseY_onImage = e.clientY - containerRect.top - imageOffsetYInContainer;

    // Clamp mouse to be within the visual image bounds
    mouseX_onImage = Math.max(0, Math.min(mouseX_onImage, visualImageWidth));
    mouseY_onImage = Math.max(0, Math.min(mouseY_onImage, visualImageHeight));

    let newRect = { ...cropRect }; // cropRect is already image-relative
    const currentTargetAspectRatio = targetAspectRatio;


    if (isDraggingRect) {
      newRect.x = mouseX_onImage - dragStartOffset.x;
      newRect.y = mouseY_onImage - dragStartOffset.y;
    } else if (isResizingRect) {
      const { x: currentX, y: currentY, width: currentWidth, height: currentHeight } = cropRect;
      const prevRight = currentX + currentWidth;
      const prevBottom = currentY + currentHeight;

      let newX = currentX, newY = currentY, newWidth = currentWidth, newHeight = currentHeight;

      // Calculate new dimensions/positions based on handle and mouse movement (image-relative)
      if (isResizingRect.includes('e')) newWidth = mouseX_onImage - currentX;
      if (isResizingRect.includes('s')) newHeight = mouseY_onImage - currentY;
      if (isResizingRect.includes('w')) {
        newWidth = prevRight - mouseX_onImage;
        newX = mouseX_onImage;
      }
      if (isResizingRect.includes('n')) {
        newHeight = prevBottom - mouseY_onImage;
        newY = mouseY_onImage;
      }
      
      // Aspect ratio maintenance
      if (isResizingRect.length === 1) { // Edge handles (n, s, e, w)
        if (['n', 's'].includes(isResizingRect)) { // Vertical resize, adjust width
            newHeight = Math.max(minAllowedSizePx, newHeight); // Ensure min height
            newWidth = Math.round(newHeight * currentTargetAspectRatio);
            newX = currentX + (currentWidth - newWidth) / 2; // Center horizontally
        } else { // Horizontal resize, adjust height (e, w)
            newWidth = Math.max(minAllowedSizePx, newWidth); // Ensure min width
            newHeight = Math.round(newWidth / currentTargetAspectRatio);
            newY = currentY + (currentHeight - newHeight) / 2; // Center vertically
        }
      } else { // Corner handles (nw, ne, sw, se)
         let anchorX = 0, anchorY = 0; // Anchor point is the opposite corner
         if (isResizingRect === 'nw') { anchorX = prevRight; anchorY = prevBottom; }
         else if (isResizingRect === 'ne') { anchorX = currentX; anchorY = prevBottom; }
         else if (isResizingRect === 'sw') { anchorX = prevRight; anchorY = currentY; }
         else if (isResizingRect === 'se') { anchorX = currentX; anchorY = currentY; }

         const deltaX = Math.abs(mouseX_onImage - anchorX);
         const deltaY = Math.abs(mouseY_onImage - anchorY);

         if (deltaX / currentTargetAspectRatio >= deltaY) { // Width-driven change
            newWidth = Math.max(minAllowedSizePx, deltaX); 
            newHeight = Math.round(newWidth / currentTargetAspectRatio);
         } else { // Height-driven change
            newHeight = Math.max(minAllowedSizePx, deltaY); 
            newWidth = Math.round(newHeight * currentTargetAspectRatio);
         }
         // Adjust X/Y based on which corner is being dragged
         if (isResizingRect.includes('w')) newX = anchorX - newWidth; else newX = anchorX;
         if (isResizingRect.includes('n')) newY = anchorY - newHeight; else newY = anchorY;
      }
      newRect = { x: newX, y: newY, width: newWidth, height: newHeight };
    }

    // Apply constraints (clamping to image bounds, min size, aspect ratio)
    // visualImageWidth and visualImageHeight are the bounds for the image-relative newRect
    const constrainedRect = applyCropRectConstraints(newRect, visualImageWidth, visualImageHeight, currentTargetAspectRatio);
    
    // Only update state if the rectangle has actually changed to prevent infinite loops
    if (constrainedRect.x !== cropRect.x || constrainedRect.y !== cropRect.y || 
        constrainedRect.width !== cropRect.width || constrainedRect.height !== cropRect.height) {
        setCropRect(constrainedRect);
    }
  }, [cropRect, isDraggingRect, isResizingRect, dragStartOffset, getDisplayDimensions, originalImageDimensions, applyCropRectConstraints, targetAspectRatio]);


  const handleMouseUp = useCallback(() => {
    setIsDraggingRect(false);
    setIsResizingRect(null);
  }, []);

  useEffect(() => {
    if (isDraggingRect || isResizingRect) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    } else {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    }
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDraggingRect, isResizingRect, handleMouseMove, handleMouseUp]);


  const resizeHandles: ResizeHandle[] = ['nw', 'ne', 'se', 'sw', 'n', 's', 'w', 'e'];
  const currentDisplayDimensions = getDisplayDimensions(); 
  
  const dynamicImageContainerStyle = (originalImageDimensions && originalImageDimensions.width > 0 && originalImageDimensions.height > 0)
    ? { 
        maxHeight: '60vh', 
        maxWidth: '100%', // Ensure it doesn't exceed column width
        position: 'relative' as 'relative', 
        // aspectRatio will be determined by NextImage content
      }
    : { // Fallback style for when image isn't loaded
        minHeight: '200px', 
        backgroundColor: 'hsl(var(--muted))', // Use theme color
        width: '100%', // Take full width for the placeholder box
        position: 'relative' as 'relative',
      };


  return (
    <Card
      className={`w-full max-w-4xl shadow-2xl rounded-xl transition-all duration-300 ease-out
                  ${isDraggingUpload ? "border-primary ring-2 ring-primary bg-accent/10" : "border-border"} animate-in fade-in duration-500`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      <CardHeader className="pb-4">
        <CardTitle className="text-3xl font-bold text-center text-primary">Interactive Smart Cropper</CardTitle>
        <CardDescription className="text-center text-muted-foreground">
          AI suggests a crop, then you can adjust it. Drag & drop or click to upload.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {!originalPreview && (
          <div
            onClick={() => fileInputRef.current?.click()}
            className={`flex flex-col items-center justify-center p-8 border-2 border-dashed rounded-lg transition-all duration-300
              cursor-pointer hover:border-accent min-h-[200px]
              ${isDraggingUpload ? "border-primary bg-accent/10" : "border-border"}
              ${!originalPreview ? 'animate-in fade-in-0 zoom-in-95' : 'animate-out fade-out-0 zoom-out-95'}`}
          >
            <UploadCloud className={`h-16 w-16 mb-4 ${isDraggingUpload ? 'text-primary' : 'text-muted-foreground'}`} />
            <p className="text-lg font-medium text-foreground">{isDraggingUpload ? "Drop image here" : "Drag & drop or click to upload"}</p>
            <p className="text-sm text-muted-foreground">Supports JPG, PNG, GIF, WEBP</p>
            <Input type="file" ref={fileInputRef} onChange={onFileSelect} className="hidden" accept="image/*" aria-label="Upload image" />
          </div>
        )}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmitDimensions)} className="space-y-6">
            {originalPreview && originalImageDimensions && (
              <div className="grid grid-cols-1 md:grid-cols-5 gap-6 items-start animate-in fade-in-0 duration-500">
                <div className="md:col-span-3 space-y-2 flex flex-col items-center"> {/* Centering parent for imageContainerRef */}
                  <Label className="text-sm font-medium text-foreground mb-1 block self-start">Original Image (Adjust Crop Area)</Label>
                  <div 
                    ref={imageContainerRef}
                    className="border border-border bg-muted/30 rounded-lg overflow-hidden touch-none select-none inline-block" 
                    style={{
                        cursor: isDraggingRect ? 'grabbing' : (isResizingRect ? `${isResizingRect}-resize` : (cropRect ? 'grab' : 'default')),
                        ...dynamicImageContainerStyle
                     }}
                  >
                    {(cropRect === null && (isLoadingAiSuggestion || !isVisualImageReady)) && originalPreview && ( 
                        <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/70 z-20 animate-in fade-in-0">
                            <Loader2 className="h-12 w-12 animate-spin text-primary" />
                            <p className="mt-2 text-sm text-muted-foreground">
                                {!isVisualImageReady ? "Loading image..." : "AI suggesting crop..."}
                            </p>
                        </div>
                    )}
                    <NextImage
                        src={originalPreview}
                        alt="Original"
                        width={originalImageDimensions.width} 
                        height={originalImageDimensions.height}
                        className="block" 
                        style={{
                            display: 'block', 
                            maxWidth: '100%',      // Fit container's maxWidth
                            maxHeight: 'inherit',  // Fit container's maxHeight (60vh)
                            width: 'auto',         // Maintain aspect ratio
                            height: 'auto',        // Maintain aspect ratio
                            objectFit: 'contain',  // Ensure full image is visible within its calculated box
                        }}
                        data-ai-hint="uploaded image"
                        unoptimized
                        priority
                        draggable={false} 
                        onLoad={() => {
                            // Short delay to ensure browser has rendered and dimensions are stable
                            setTimeout(() => { 
                                const imgEl = imageContainerRef.current?.querySelector('img');
                                if (imgEl && imgEl.clientWidth > 0 && imgEl.clientHeight > 0) {
                                    setIsVisualImageReady(true);
                                } else { 
                                     // Fallback if querySelector fails or dimensions are zero initially
                                     setTimeout(() => setIsVisualImageReady(true), 500); 
                                }
                            }, 250); 
                        }}
                    />
                    {/* Crop rectangle and handles are positioned relative to imageContainerRef, 
                        but their logical calculations use image-relative coordinates. */}
                    {cropRect && currentDisplayDimensions && isVisualImageReady && (
                      <>
                        <div 
                          className={`absolute border-2 shadow-lg transition-colors duration-200 ${
                            showUpscalingWarning
                              ? "border-red-500 bg-red-500/30" 
                              : "border-primary bg-primary/20" 
                          }`}
                          style={{
                            // Position the cropRect visual element using offsets + image-relative coords
                            left: `${currentDisplayDimensions.imageOffsetXInContainer + cropRect.x}px`,
                            top: `${currentDisplayDimensions.imageOffsetYInContainer + cropRect.y}px`,
                            width: `${cropRect.width}px`,
                            height: `${cropRect.height}px`,
                            cursor: 'inherit', // Inherit from parent imageContainerRef
                          }}
                          onMouseDown={handleRectMouseDown}
                        >
                           <div className="absolute inset-0 " /> {/* Clickable area */}
                        </div>
                        {resizeHandles.map(handle => (
                          <div
                            key={handle}
                            onMouseDown={(e) => handleResizeMouseDown(e, handle)}
                            className={`absolute border rounded-full w-3 h-3 z-10 transition-colors duration-200 ${
                                showUpscalingWarning
                                ? "bg-red-600 border-white"
                                : "bg-primary border-background" 
                            }`} 
                            style={{ // Handles are positioned relative to the cropRect's top-left corner on screen
                              cursor: `${handle}-resize`,
                              left: `${currentDisplayDimensions.imageOffsetXInContainer + cropRect.x + (handle.includes('w') ? 0 : handle.includes('e') ? cropRect.width : cropRect.width / 2) - 6}px`,
                              top: `${currentDisplayDimensions.imageOffsetYInContainer + cropRect.y + (handle.includes('n') ? 0 : handle.includes('s') ? cropRect.height : cropRect.height / 2) - 6}px`,
                            }}
                          />
                        ))}
                      </>
                    )}
                  </div>
                </div>

                <div className="md:col-span-2 space-y-4">
                    <div>
                        <Label className="text-sm font-medium text-foreground mb-2 block">Crop Output Dimensions</Label>
                        <div className="grid grid-cols-2 gap-4">
                        <FormField
                            control={form.control} name="width"
                            render={({ field }) => (
                            <FormItem>
                                <FormLabel>Width (px)</FormLabel>
                                <FormControl><Input type="number" placeholder="600" {...field} aria-label="Crop width" /></FormControl>
                                <FormMessage />
                            </FormItem>
                            )}
                        />
                        <FormField
                            control={form.control} name="height"
                            render={({ field }) => (
                            <FormItem>
                                <FormLabel>Height (px)</FormLabel>
                                <FormControl><Input type="number" placeholder="400" {...field} aria-label="Crop height" /></FormControl>
                                <FormMessage />
                            </FormItem>
                            )}
                        />
                        </div>
                    </div>
                     <Button type="submit" disabled={isCropping || isLoadingAiSuggestion || !cropRect || !originalPreview || !isVisualImageReady} className="w-full text-base py-3">
                        {isCropping ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <Scissors className="mr-2 h-5 w-5" />}
                        {isCropping ? "Cropping..." : "Smart Crop Image"}
                    </Button>

                  <div>
                    <Label className="text-sm font-medium text-foreground mb-2 block">Cropped Preview</Label>
                    <div className="aspect-[3/2] w-full rounded-lg overflow-hidden border border-border bg-muted/50 flex items-center justify-center animate-in fade-in duration-300">
                      {isCropping ? (
                        <div className="flex flex-col items-center justify-center h-full animate-in fade-in-0">
                          <Loader2 className="h-12 w-12 animate-spin text-primary" />
                          <p className="mt-2 text-sm text-muted-foreground">Processing crop...</p>
                        </div>
                      ) : croppedPreview ? (
                        <NextImage src={croppedPreview} alt="Cropped"
                            width={targetWidth} height={targetHeight} // Use actual target dimensions for preview display
                            className="object-contain max-w-full max-h-full animate-in fade-in-0 duration-500"
                            data-ai-hint="ai guided crop" unoptimized />
                      ) : (
                         <div className="flex flex-col items-center justify-center h-full text-muted-foreground animate-in fade-in-0">
                          <ImageIcon className="h-12 w-12 mb-2" />
                          <p className="text-sm">Cropped image will appear here</p>
                        </div>
                      )}
                    </div>
                     {croppedPreview && !isCropping && (
                      <Button onClick={handleDownload} className="w-full mt-2 bg-accent hover:bg-accent/90 text-accent-foreground" type="button">
                        <Download className="mr-2 h-4 w-4" /> Download Cropped Image
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </form>
        </Form>
      </CardContent>
      <CardFooter className="pt-4 border-t border-border">
        <p className="text-xs text-muted-foreground text-center w-full">
          Drag and drop a new image anytime. AI suggests an initial crop. Drag and resize the rectangle to refine.
        </p>
      </CardFooter>
    </Card>
  );
}
