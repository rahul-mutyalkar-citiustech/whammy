import { decode as atob, encode as btoa } from 'base-64';

/**
 * Whammy - A real-time javascript WebM encoder
 * Converts canvas frames to WebM video format
 */

// Constants
const CLUSTER_MAX_DURATION = 30000; // milliseconds
const TIMECODE_SCALE = 1e6; // nanoseconds (1ms)
const DEFAULT_QUALITY = 0.8;

// EBML (Extensible Binary Meta Language) IDs
const EBML_IDS = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  Cluster: 0x1f43b675,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTrackPositions: 0xb7,
  SimpleBlock: 0xa3
};

/**
 * Validates frame consistency
 */
function validateFrames(frames) {
  if (!frames || frames.length === 0) {
    throw new Error('No frames provided');
  }

  const { width, height } = frames[0];
  let totalDuration = frames[0].duration;

  for (let i = 1; i < frames.length; i++) {
    const frame = frames[i];

    if (frame.width !== width) {
      throw new Error(`Frame ${i + 1} has inconsistent width: ${frame.width} vs ${width}`);
    }

    if (frame.height !== height) {
      throw new Error(`Frame ${i + 1} has inconsistent height: ${frame.height} vs ${height}`);
    }

    if (frame.duration < 0 || frame.duration > 0x7fff) {
      throw new Error(`Frame ${i + 1} has invalid duration: ${frame.duration} (must be 0-32767)`);
    }

    totalDuration += frame.duration;
  }

  return { duration: totalDuration, width, height };
}

/**
 * Converts number to variable-length buffer
 */
function numToBuffer(num) {
  const parts = [];
  while (num > 0) {
    parts.push(num & 0xff);
    num = num >> 8;
  }
  return new Uint8Array(parts.reverse());
}

/**
 * Converts number to fixed-size buffer
 */
function numToFixedBuffer(num, size) {
  const parts = new Uint8Array(size);
  for (let i = size - 1; i >= 0; i--) {
    parts[i] = num & 0xff;
    num = num >> 8;
  }
  return parts;
}

/**
 * Converts string to Uint8Array buffer
 */
function strToBuffer(str) {
  const arr = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    arr[i] = str.charCodeAt(i);
  }
  return arr;
}

/**
 * Converts binary string to buffer
 */
function bitsToBuffer(bits) {
  const pad = (bits.length % 8) ? '0'.repeat(8 - (bits.length % 8)) : '';
  const paddedBits = pad + bits;
  const data = [];

  for (let i = 0; i < paddedBits.length; i += 8) {
    data.push(parseInt(paddedBits.substr(i, 8), 2));
  }

  return new Uint8Array(data);
}

/**
 * Converts double to string representation for EBML
 */
function doubleToString(num) {
  return Array.from(
    new Uint8Array(new Float64Array([num]).buffer)
  )
    .map(byte => String.fromCharCode(byte))
    .reverse()
    .join('');
}

/**
 * Flattens nested array structure
 */
function flattenArray(arr, output = []) {
  for (const item of arr) {
    if (typeof item === 'object' && item.length !== undefined) {
      flattenArray(item, output);
    } else {
      output.push(item);
    }
  }
  return output;
}

/**
 * Generates EBML structure from JSON
 */
function generateEBML(json, outputAsArray = false) {
  const ebml = [];

  for (let i = 0; i < json.length; i++) {
    const element = json[i];

    // Already encoded data
    if (!element.id) {
      ebml.push(element);
      continue;
    }

    // Process element data
    let data = element.data;

    if (typeof data === 'object') {
      data = generateEBML(data, outputAsArray);
    } else if (typeof data === 'number') {
      data = element.size
        ? numToFixedBuffer(data, element.size)
        : bitsToBuffer(data.toString(2));
    } else if (typeof data === 'string') {
      data = strToBuffer(data);
    }

    // Calculate size
    const len = data.size || data.byteLength || data.length;
    const zeroes = Math.ceil(Math.ceil(Math.log(len) / Math.log(2)) / 8);
    const sizeStr = len.toString(2);
    const padded = '0'.repeat((zeroes * 7 + 7 + 1) - sizeStr.length) + sizeStr;
    const size = '0'.repeat(zeroes) + '1' + padded;

    ebml.push(numToBuffer(element.id));
    ebml.push(bitsToBuffer(size));
    ebml.push(data);
  }

  return outputAsArray
    ? new Uint8Array(flattenArray(ebml))
    : new Blob(ebml, { type: 'video/webm' });
}

/**
 * Creates a SimpleBlock for WebM
 */
function makeSimpleBlock({ trackNum, timecode, keyframe, invisible, lacing, discardable, frame }) {
  if (trackNum > 127) {
    throw new Error('TrackNumber > 127 not supported');
  }

  let flags = 0;
  if (keyframe) flags |= 128;
  if (invisible) flags |= 8;
  if (lacing) flags |= (lacing << 1);
  if (discardable) flags |= 1;

  const header = [
    trackNum | 0x80,
    timecode >> 8,
    timecode & 0xff,
    flags
  ].map(byte => String.fromCharCode(byte)).join('');

  return header + frame;
}

/**
 * Parses RIFF container format
 */
function parseRIFF(string) {
  let offset = 0;
  const chunks = {};

  while (offset < string.length) {
    const id = string.substr(offset, 4);
    chunks[id] = chunks[id] || [];

    if (id === 'RIFF' || id === 'LIST') {
      const lenBytes = string.substr(offset + 4, 4);
      const len = parseInt(
        lenBytes.split('')
          .map(char => char.charCodeAt(0).toString(2).padStart(8, '0'))
          .join(''),
        2
      );
      const data = string.substr(offset + 8, len);
      offset += 8 + len;
      chunks[id].push(parseRIFF(data));
    } else if (id === 'WEBP') {
      chunks[id].push(string.substr(offset + 8));
      offset = string.length;
    } else {
      chunks[id].push(string.substr(offset + 4));
      offset = string.length;
    }
  }

  return chunks;
}

/**
 * Parses WebP frame data
 */
function parseWebP(riff) {
  const VP8 = riff.RIFF[0].WEBP[0];
  const frameStart = VP8.indexOf('\x9d\x01\x2a'); // VP8 keyframe header

  const bytes = [];
  for (let i = 0; i < 4; i++) {
    bytes[i] = VP8.charCodeAt(frameStart + 3 + i);
  }

  const tmp1 = (bytes[1] << 8) | bytes[0];
  const width = tmp1 & 0x3FFF;
  const horizontalScale = tmp1 >> 14;

  const tmp2 = (bytes[3] << 8) | bytes[2];
  const height = tmp2 & 0x3FFF;
  const verticalScale = tmp2 >> 14;

  return {
    width,
    height,
    data: VP8,
    riff,
    horizontalScale,
    verticalScale
  };
}

/**
 * Creates EBML header structure
 */
function createEBMLHeader(info) {
  return {
    id: EBML_IDS.EBML,
    data: [
      { data: 1, id: 0x4286 }, // EBMLVersion
      { data: 1, id: 0x42f7 }, // EBMLReadVersion
      { data: 4, id: 0x42f2 }, // EBMLMaxIDLength
      { data: 8, id: 0x42f3 }, // EBMLMaxSizeLength
      { data: 'webm', id: 0x4282 }, // DocType
      { data: 2, id: 0x4287 }, // DocTypeVersion
      { data: 2, id: 0x4285 }  // DocTypeReadVersion
    ]
  };
}

/**
 * Creates segment info structure
 */
function createSegmentInfo(duration) {
  return {
    id: EBML_IDS.Info,
    data: [
      { data: TIMECODE_SCALE, id: 0x2ad7b1 }, // TimecodeScale
      { data: 'whammy', id: 0x4d80 }, // MuxingApp
      { data: 'whammy', id: 0x5741 }, // WritingApp
      { data: doubleToString(duration), id: 0x4489 } // Duration
    ]
  };
}

/**
 * Creates tracks structure
 */
function createTracks(width, height) {
  return {
    id: EBML_IDS.Tracks,
    data: [{
      id: EBML_IDS.TrackEntry,
      data: [
        { data: 1, id: 0xd7 }, // TrackNumber
        { data: 1, id: 0x73c5 }, // TrackUID
        { data: 0, id: 0x9c }, // FlagLacing
        { data: 'und', id: 0x22b59c }, // Language
        { data: 'V_VP8', id: 0x86 }, // CodecID
        { data: 'VP8', id: 0x258688 }, // CodecName
        { data: 1, id: 0x83 }, // TrackType
        {
          id: 0xe0, // Video
          data: [
            { data: width, id: 0xb0 }, // PixelWidth
            { data: height, id: 0xba } // PixelHeight
          ]
        }
      ]
    }]
  };
}

/**
 * Converts frames to WebM format
 */
function toWebM(frames, outputAsArray = false) {
  const info = validateFrames(frames);

  const segment = {
    id: EBML_IDS.Segment,
    data: [
      createSegmentInfo(info.duration),
      createTracks(info.width, info.height),
      { id: EBML_IDS.Cues, data: [] }
    ]
  };

  const cues = segment.data[2];
  let frameNumber = 0;
  let clusterTimecode = 0;

  // Generate clusters
  while (frameNumber < frames.length) {
    const cuePoint = {
      id: EBML_IDS.CuePoint,
      data: [
        { data: Math.round(clusterTimecode), id: 0xb3 }, // CueTime
        {
          id: EBML_IDS.CueTrackPositions,
          data: [
            { data: 1, id: 0xf7 }, // CueTrack
            { data: 0, size: 8, id: 0xf1 } // CueClusterPosition
          ]
        }
      ]
    };

    cues.data.push(cuePoint);

    const clusterFrames = [];
    let clusterDuration = 0;

    // Collect frames for this cluster
    do {
      clusterFrames.push(frames[frameNumber]);
      clusterDuration += frames[frameNumber].duration;
      frameNumber++;
    } while (frameNumber < frames.length && clusterDuration < CLUSTER_MAX_DURATION);

    // Create cluster
    let clusterCounter = 0;
    const cluster = {
      id: EBML_IDS.Cluster,
      data: [
        { data: Math.round(clusterTimecode), id: 0xe7 } // Timecode
      ].concat(
        clusterFrames.map(webp => {
          const block = makeSimpleBlock({
            discardable: 0,
            frame: webp.data.slice(webp.data.indexOf('\x9d\x01\x2a') - 3),
            invisible: 0,
            keyframe: 1,
            lacing: 0,
            trackNum: 1,
            timecode: Math.round(clusterCounter)
          });
          clusterCounter += webp.duration;
          return { data: block, id: EBML_IDS.SimpleBlock };
        })
      )
    };

    segment.data.push(cluster);
    clusterTimecode += clusterDuration;
  }

  // Calculate cluster positions for cues
  let position = 0;
  for (let i = 0; i < segment.data.length; i++) {
    if (i >= 3) {
      cues.data[i - 3].data[1].data[1].data = position;
    }
    const data = generateEBML([segment.data[i]], outputAsArray);
    position += data.size || data.byteLength || data.length;
    if (i !== 2) {
      segment.data[i] = data;
    }
  }

  return generateEBML([createEBMLHeader(info), segment], outputAsArray);
}

/**
 * WhammyVideo class - Main API for creating WebM videos
 */
class WhammyVideo {
  constructor(speed, quality = DEFAULT_QUALITY) {
    this.frames = [];
    this.duration = speed ? 1000 / speed : null;
    this.quality = quality;
  }

  /**
   * Adds a frame to the video
   */
  add(frame, duration) {
    console.log('Whammy Add : ', duration, this.duration);
    // && typeof duration !== "undefined"
    if (!!duration) {  // if (duration !== undefined && this.duration) {
      //   throw new Error("Cannot specify duration when FPS is set");
      // }
      // if (duration === undefined && !this.duration) {
      //   throw new Error("Must specify duration when FPS is not set");
      // }
      // Handle canvas context
      if (frame.canvas) {
        frame = frame.canvas;
      }

      // Handle canvas element
      if (frame.toDataURL) {
        frame = frame.getContext('2d').getImageData(0, 0, frame.width, frame.height);
      } else if (typeof frame === 'string') {
        if (!(/^data:image\/webp;base64,/i).test(frame)) {
          //throw new Error("String input must be a base64 encoded DataURI of type image/webp");
        }
      } else if (!(frame instanceof ImageData)) {
        //throw new Error("Frame must be HTMLCanvasElement, CanvasRenderingContext2D, ImageData, or DataURI string");
      }

      this.frames.push({
        image: frame,
        duration: duration || this.duration
      });
    }
    console.log('Whammy Add : ', duration, this.frames);
  }

  /**
   * Encodes ImageData frames to WebP DataURLs
   */
  encodeFrames(callback) {
    if (!(this.frames[0].image instanceof ImageData)) {
      callback();
      return;
    }

    const tmpCanvas = document.createElement('canvas');
    const tmpContext = tmpCanvas.getContext('2d');
    tmpCanvas.width = this.frames[0].image.width;
    tmpCanvas.height = this.frames[0].image.height;

    const encodeFrame = (index) => {
      const frame = this.frames[index];
      tmpContext.putImageData(frame.image, 0, 0);
      frame.image = tmpCanvas.toDataURL('image/webp', this.quality);

      if (index < this.frames.length - 1) {
        setTimeout(() => encodeFrame(index + 1), 1);
      } else {
        callback();
      }
    };

    encodeFrame(0);
  }

  /**
   * Compiles frames into WebM video
   */
  compile(outputAsArray = false, callback) {
    this.encodeFrames(() => {
      try {
        const webm = toWebM(
          this.frames.map(frame => {
            const webp = parseWebP(parseRIFF(atob(frame.image.slice(23))));
            webp.duration = frame.duration;
            return webp;
          }),
          outputAsArray
        );
        callback(webm);
      } catch (err) {
        callback({ error: err });
      }
    });
  }
}

/**
 * Public API
 */
export const Whammy = {
  Video: WhammyVideo,

  fromImageArray(images, fps, outputAsArray = false) {
    return toWebM(
      images.map(image => {
        const webp = parseWebP(parseRIFF(atob(image.slice(23))));
        webp.duration = 1000 / fps;
        return webp;
      }),
      outputAsArray
    );
  },

  toWebM
};