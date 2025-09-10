/**
 * @license
 * Copyright (C) 2021, 2022, 2023  WofWca <wofwca@protonmail.com>
 *
 * This file is part of Jump Cutter Browser Extension.
 *
 * Jump Cutter Browser Extension is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Jump Cutter Browser Extension is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Jump Cutter Browser Extension.  If not, see <https://www.gnu.org/licenses/>.
 */

import { browserOrChrome } from '@/webextensions-api-browser-or-chrome';
import Lookahead, { TimeRange } from './Lookahead';
import { assertDev, AudioContextTime, SpeedName } from '@/helpers';
import type { MediaTime, AnyTime } from '@/helpers';
import { isPlaybackActive, destroyAudioWorkletNode, requestIdleCallbackPolyfill,
  maybeClosestNonNormalSpeed } from '@/entry-points/content/helpers';
import { ControllerKind } from '@/settings';
import type { Settings as ExtensionSettings } from '@/settings';
import throttle from 'lodash/throttle';
import type TimeSavedTracker from '@/entry-points/content/TimeSavedTracker';
import VolumeFilterNode from '@/entry-points/content/VolumeFilter/VolumeFilterNode';
import lookaheadVolumeFilterSmoothing from './lookaheadVolumeFilterSmoothing.json'
import {
  audioContext as commonAudioContext,
} from '@/entry-points/content/audioContext';
import {
  getOrCreateMediaElementSourceAndUpdateMap
} from '@/entry-points/content/getOrCreateMediaElementSourceAndUpdateMap';
import {
  setPlaybackRateAndRememberIt,
  setDefaultPlaybackRateAndRememberIt,
} from '../playbackRateChangeTracking';
import { browserHasAudioDesyncBug } from '@/helpers/browserHasAudioDesyncBug';
import requestIdlePromise from '../helpers/requestIdlePromise';

type Time = AnyTime;

type ControllerInitialized =
  Controller
  & { initialized: true }
  & Required<Pick<Controller, 'initialized'>>;

export type ControllerSettings =
  Pick<
    ExtensionSettings,
    'volumeThreshold'
    | 'soundedSpeed'
    | 'marginBefore'
    | 'marginAfter'
    | 'enableDesyncCorrection'
  > & {
    silenceSpeed: number,
    /**
     * Whether we should be skipping sounded (loud) parts
     * instead of silent parts.
     *
     * This is only supported by the cloning controller.
     */
    isOppositeDay: boolean
  };

export interface TelemetryRecord {
  clonePlaybackError?: true,
  unixTime: Time,
  intrinsicTime: MediaTime,
  elementPlaybackActive: boolean,
  contextTime: Time,
  inputVolume: number,
  lastActualPlaybackRateChange: {
    time: Time,
    value: number,
    name: SpeedName,
  },
  lastSilenceSkippingSeek?: TimeRange,
  elementVolume: number,
  totalOutputDelay: Time,
  delayFromInputToStretcherOutput: Time,
  stretcherDelay: Time,
  lastScheduledStretchInputTime?: undefined,
}

const seekDurationProphetHistoryLength = 5;
const seekDurationProphetNoDataInitialAssumedDuration = 150;
/**
 * Tells us how long (based on previous data) the next seek is gonna take.
 */
class SeekDurationProphet {
  el: HTMLMediaElement
  // TODO perf: replace with a ring buffer (we have one in `VolumeFilterProcessor`)?
  history: number[] = [];
  historyAverage = seekDurationProphetNoDataInitialAssumedDuration;
  /** Can be called several times. Only the first call has effect. */
  public destroy!: () => void;
  private _destroyedPromise = new Promise<void>(r => this.destroy = r);
  lastSeekStartTime: number = performance.now();
  constructor (el: HTMLMediaElement) {
    this.el = el;
    // Keep in mind that 'seeking' can be fired more than once before 'seeked' is fired, if the previous
    // seek didn't manage to finish.
    const onSeeking = this.onSeeking.bind(this);
    const onSeeked = this.onSeeked.bind(this);
    el.addEventListener('seeking', onSeeking, { passive: true });
    el.addEventListener('seeked', onSeeked, { passive: true });
    this._destroyedPromise.then(() => {
      el.removeEventListener('seeking', onSeeking);
      el.removeEventListener('seeked', onSeeked);
    })
  }
  onSeeking(e: Event) {
    // Keep in mind that it is possible for the constructor to be called after a 'seeking' event has
    // been fired, but before 'seeked'. `performance.now()` is not technically correct, but
    // handling this being `undefined` separately seems worse.
    this.lastSeekStartTime = e.timeStamp;

    // TODO improvement: probably need to take into account whether a seek has been performed
    // into an unbuffered range and adjust the seek duration accordingly or not consider it at all.
    // if (inRanges(this.el.buffered, this.el.currentTime))
  }
  onSeeked(e: Event) {
    const seekDuration = e.timeStamp - this.lastSeekStartTime;

    // if (seekDuration > 2000) return;

    this.history.push(seekDuration);
    // TODO perf: - once this becomes `true`, it will never cease to.
    if (this.history.length > seekDurationProphetHistoryLength) {
      this.history.shift();
    }
    // TODO perf: only consider the removed and the added element, not recalculate the whole array
    // every time
    const sum = this.history.reduce((acc, curr) => acc + curr);
    this.historyAverage = sum / this.history.length;
  }
  get nextSeekDurationMs(): number {
    return this.historyAverage;
  }
}

const DO_DESYNC_CORRECTION_EVERY_N_SPEED_SWITCHES = 20;

const getActualPlaybackRateForSpeed = maybeClosestNonNormalSpeed;

// TODO refactor: a lot of stuff is copy-pasted from ElementPlaybackControllerStretching.
/**
 * Controls playback rate (and `.currentTime`) of an `HTMLMediaElement` (like the other ones).
 * Searches for silent parts by creating a new hidden `HTMLMediaElement` with the same `src` as the
 * target one and playing it separately, in advance of the target one.
 */
export default class Controller {
  static controllerType = ControllerKind.CLONING;

  // I'd be glad to make most of these `private` but this makes it harder to specify types in this file.
  // TODO refactor. Maybe I'm just too bad at TypeScript.
  readonly element: HTMLMediaElement;
  settings: ControllerSettings;
  initialized = false;
  _resolveInitPromise!: (result: Controller) => void;
  // TODO how about also rejecting it when `init()` throws? Would need to put the whole initialization in the promise
  // executor?
  _initPromise = new Promise<Controller>(resolve => this._resolveInitPromise = resolve);
  // Settings updates that haven't been applied because `updateSettingsAndMaybeCreateNewInstance` was called before
  // `init` finished.
  _pendingSettingsUpdates: ControllerSettings | undefined;

  private _resolveDestroyedPromise!: () => void;
  private _destroyedPromise = new Promise<void>(r => this._resolveDestroyedPromise = r);
  audioContext: AudioContext;
  getVolume: () => number = () => 0;
  _lastSilenceSkippingSeek: TimeRange | undefined;
  _lastActualPlaybackRateChange: {
    time: AudioContextTime,
    value: number,
    // name: SpeedName.SOUNDED,
    name: SpeedName,
  } = {
    // Dummy values (except for `name`), will be ovewritten in `_setSpeedAndLog`.
    name: SpeedName.SOUNDED,
    time: 0,
    value: 1,
  };

  lookahead?: Lookahead;
  clonePlaybackError = false;

  public timeSavedTracker?: TimeSavedTracker;

  seekDurationProphet: SeekDurationProphet;

  _didNotDoDesyncCorrectionForNSpeedSwitches = 0;

  // TODO refactor: make this a constructor parameter for this Controller.
  private readonly getMediaSourceCloneElement: ConstructorParameters<typeof Lookahead>[2] =
    (originalElement) => import(
      /* webpackExports: ['getMediaSourceCloneElement']*/
      '@/entry-points/content/cloneMediaSources/getMediaSourceCloneElement'
    ).then(({ getMediaSourceCloneElement }) => getMediaSourceCloneElement(originalElement));

  constructor(
    element: HTMLMediaElement,
    controllerSettings: ControllerSettings,
    timeSavedTracker: TimeSavedTracker | Promise<TimeSavedTracker | undefined> | undefined,
  ) {
    this.element = element;
    this.settings = controllerSettings;

    const lookahead = this.lookahead = new Lookahead(
      element,
      this.settings,
      this.getMediaSourceCloneElement,
      () => this.clonePlaybackError = true
    );
    // Destruction is performed in `this.destroy` directly.
    lookahead.ensureInit();

    if (timeSavedTracker instanceof Promise) {
      timeSavedTracker.then(tracker => this.timeSavedTracker = tracker);
    } else {
      this.timeSavedTracker = timeSavedTracker;
    }

    const seekDurationProphet = this.seekDurationProphet = new SeekDurationProphet(element);
    this._destroyedPromise.then(() => seekDurationProphet.destroy());

    // We don't need a high sample rate as this context is currently only used to volume on the chart,
    // so consider setting it manually to a lower one. But I'm thinking whether it woruld actually
    // add performance overhead instead (would make resampling harder or something).
    const audioContext = this.audioContext = new AudioContext({
      latencyHint: 'playback',
    });
    this._destroyedPromise.then(() => {
      audioContext.close();
    })
  }

  isInitialized(): this is ControllerInitialized {
    return this.initialized;
  }

  async init(): Promise<void> {
    const element = this.element;

    const toAwait: Array<Promise<void>> = [];

    const {
      playbackRate: elementPlaybackRateBeforeInitialization,
      defaultPlaybackRate: elementDefaultPlaybackRateBeforeInitialization,
    } = element;
    this._destroyedPromise.then(() => {
      setPlaybackRateAndRememberIt(element, elementPlaybackRateBeforeInitialization);
      setDefaultPlaybackRateAndRememberIt(element, elementDefaultPlaybackRateBeforeInitialization);
    });

    toAwait.push(this.lookahead!.ensureInit().then(() => {
      // TODO perf: super inefficient, I know.
      const onTimeupdate = () => {
        this.maybeScheduleMaybeSeekOrSpeedup();
      }
      element.addEventListener('timeupdate', onTimeupdate, { passive: true });
      this._destroyedPromise.then(() => element.removeEventListener('timeupdate', onTimeupdate));
    }));

    const onNewSrc = () => {
      // This indicated that `element.currentSrc` has changed.
      // https://html.spec.whatwg.org/multipage/media.html#dom-media-currentsrc
      // > Its value is changed by the resource selection algorithm
      this.destroyAndThrottledInitLookahead();

      // Seek duration depends heavily on the media file, so need not to rely on old data.
      //
      // Yes, we don't undo the `this._destroyedPromise.then(` for the current
      // `seekDurationProphet`. It's a bit of a memory leak, but doesn't matter too much as
      // `seekDurationProphet.destroy()` can be called several times. TODO refactor.
      this.seekDurationProphet.destroy();
      const seekDurationProphet = this.seekDurationProphet = new SeekDurationProphet(element);
      this._destroyedPromise.then(() => seekDurationProphet.destroy());
    }
    element.addEventListener('loadstart', onNewSrc, { passive: true });
    this._destroyedPromise.then(() => element.removeEventListener('loadstart', onNewSrc));

    // Why `onNewSrc` is not enough? Because a 'timeupdate' event gets emited before 'loadstart', so
    // 'maybeScheduleMaybeSeekOrSpeedup' gets executed, and it tries to use the lookahead that was
    // used for the previous source, so if the previous source started with silence, a seek
    // will be performed immediately on the new source.
    const onOldSrcGone = () => {
      this.lookahead?.destroy();
      this.lookahead = undefined;
    }
    element.addEventListener('emptied', onOldSrcGone, { passive: true });
    this._destroyedPromise.then(() => element.removeEventListener('emptied', onOldSrcGone));

    {
      // TODO refactor: abstract this into a function that returns `getVolume`.
      // This is not strictly necessary, so not pushing anything to `toAwait`.
      //
      // Why not `createMediaElementSource`? Because:
      // * There's a risk that the element would get muted due to CORS-restrictions.
      // * I believe performance drops may cause audio to glitch when it passes through an AudioContext,
      //     so it's better to do it raw.
      // But `captureStream` is not well-supported.
      // Also keep in mind that `createMediaElementSource` and `captureStream` are not 100% interchangeable.
      // For example, for `el.volume` doesn't affect the volume for `captureStream()`.
      // TODO fix: fall-back to `createMediaElementSource` if these are not supported?
      //
      // TODO perf: destroy the stream and AudioContext when it's not necessary,
      // i.e. when the popup is closed.
      type HTMLMediaElementWithMaybeMissingFields = HTMLMediaElement & {
        captureStream?: () => MediaStream,
        mozCaptureStream?: () => MediaStream,
      }
      const element_ = element as HTMLMediaElementWithMaybeMissingFields;
      const unprefixedCaptureStreamPresent = element_.captureStream;
      const browserGecko = BUILD_DEFINITIONS.BROWSER === 'gecko';
      const captureStream =
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        (unprefixedCaptureStreamPresent && (() => element_.captureStream!()))
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        || (browserGecko && element_.mozCaptureStream && (() => element_.mozCaptureStream!()));

      if (captureStream) {
        // Also mostly copy-pasted from `ElementPlaybackControllerStretching`.
        const audioContext = this.audioContext;
        const addWorkletProcessor = (url: string) =>
          audioContext.audioWorklet.addModule(browserOrChrome.runtime.getURL(url));
        // Must be the same so what the user sees matches what the lookahead sees.
        const volumeFilterSmoothingWindowLength = lookaheadVolumeFilterSmoothing;
        const volumeFilterProcessorP = addWorkletProcessor('content/VolumeFilterProcessor.js');
        const volumeFilterP = volumeFilterProcessorP.then(() => {
          const volumeFilter = new VolumeFilterNode(
            audioContext,
            volumeFilterSmoothingWindowLength,
            volumeFilterSmoothingWindowLength
          );
          this._destroyedPromise.then(() => destroyAudioWorkletNode(volumeFilter));
          return volumeFilter;
        });

        // The following paragraph is pretty stupid because Web Audio API is still pretty new.
        // Or because I'm pretty new to it.
        let source: MediaStreamAudioSourceNode;
        let reinitScheduled = false;
        const reinit = () => {
          source?.disconnect();
          let newStream;
          // `try` because see the `catch` block.
          try {
            newStream = captureStream();
          } catch (e) {
            if (IS_DEV_MODE) {
              console.warn('Couldn\'t `captureStream`, but ignoring it because maybe we\'re here because'
                + ' `dontAttachToCrossOriginMedia` is `false` and the media is CORS-restricted', e);
            }
          }
          if (newStream) {
            // Shouldn't we do something if there are no tracks?
            if (newStream.getAudioTracks().length) {
              source = audioContext.createMediaStreamSource(newStream);
              volumeFilterP.then(filter => source.connect(filter));
            }
          }

          reinitScheduled = false;
        }
        const ensureReinitDeferred = () => {
          if (!reinitScheduled) {
            reinitScheduled = true;
            requestIdleCallbackPolyfill(reinit, { timeout: 2000 });
          }
        }

        // This means that the 'playing' has already been emited.
        // https://html.spec.whatwg.org/multipage/media.html#mediaevents:event-media-playing
        const nowPlaying = element.readyState > HTMLMediaElement.HAVE_FUTURE_DATA && !element.paused;
        const canCaptureStreamNow = nowPlaying;
        if (canCaptureStreamNow) {
          reinit();
        }
        const alreadyInitialized = canCaptureStreamNow;

        // Workaround for
        // https://bugzilla.mozilla.org/show_bug.cgi?id=1178751
        if (BUILD_DEFINITIONS.BROWSER === 'gecko') {
          const mozCaptureStreamUsed = !unprefixedCaptureStreamPresent;
          if (mozCaptureStreamUsed) {
            const [, mediaElementSource] = getOrCreateMediaElementSourceAndUpdateMap(
              element,
              () => commonAudioContext
            );
            mediaElementSource.connect(commonAudioContext.destination);
          }
        }

        // Hopefully this covers all cases where the `MediaStreamAudioSourceNode` stops working.
        // 'loadstart' is for when the source changes, 'ended' speaks for itself.
        // https://w3c.github.io/mediacapture-fromelement/#dom-htmlmediaelement-capturestream
        let unhandledLoadstartOrEndedEvent = alreadyInitialized ? false : true;
        const onPlaying = () => {
          if (unhandledLoadstartOrEndedEvent) {
            ensureReinitDeferred();
            unhandledLoadstartOrEndedEvent = false;
          }
        }
        element.addEventListener('playing', onPlaying, { passive: true });
        this._destroyedPromise.then(() => element.removeEventListener('playing', onPlaying));
        const onEndedOrLoadstart = () => {
          unhandledLoadstartOrEndedEvent = true;
        }
        element.addEventListener('loadstart', onEndedOrLoadstart, { passive: true });
        element.addEventListener('ended', onEndedOrLoadstart, { passive: true });
        this._destroyedPromise.then(() => {
          element.removeEventListener('loadstart', onEndedOrLoadstart);
          element.removeEventListener('ended', onEndedOrLoadstart);
        });

        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 2 ** 5;
        volumeFilterP.then(volumeFilter => {
          volumeFilter.connect(analyser);
        });
        // Using the minimum possible value for performance, as we're only using the node to get unchanged
        // output values.
        const volumeBuffer = new Float32Array(analyser.fftSize);
        const volumeBufferLastInd = volumeBuffer.length - 1;
        this.getVolume = () => {
          analyser.getFloatTimeDomainData(volumeBuffer);
          return volumeBuffer[volumeBufferLastInd];
        };
      } else {
        this.getVolume = () => 0;
      }
    }

    await Promise.all(toAwait);
    await requestIdlePromise({ timeout: 2000 })
    this.initialized = true;
    this._resolveInitPromise(this);

    Object.assign(this.settings, this._pendingSettingsUpdates);
    this._setStateAccordingToNewSettings(this.settings, null);
    delete this._pendingSettingsUpdates;
  }

  maybeSeekOrSpeedupTimeoutId = -1;
  /**
   * Look at the upcoming silent part and maybe schedule a call
   * to {@link Controller.maybeSeekOrSpeedup} to skip it.
   */
  maybeScheduleMaybeSeekOrSpeedup() {
    const { currentTime } = this.element;
    const maybeUpcomingSilenceRange = this.lookahead?.getNextSilenceRange(currentTime);
    if (!maybeUpcomingSilenceRange) {
      return;
    }
    const [
      [silenceStart, silenceEnd],
      isTheUpcomingSilenceRangeStillPending,
    ] = maybeUpcomingSilenceRange;

    if (this.settings.isOppositeDay) {
      if (isTheUpcomingSilenceRangeStillPending) {
        return
      }
    }

    // The fact that `isUpcomingSilenceRangeStillPending`
    // TODO improvement: would it be maybe better to also just do nothing if the next silence range
    // is too far, and `setTimeout` only when it gets closer (so `if (seekInRealTime > 10) return;`?
    // Would time accuracy increase?
    const seekAt = Math.max(silenceStart, currentTime);
    const seekTo = isTheUpcomingSilenceRangeStillPending
      // Let's not skip to the very end of the pending silence range,
      // because it's usually the end of the buffered range,
      // so if we do perform a seek, the video will not be able to play.
      ? Math.max(seekAt, silenceEnd - 3)
      : silenceEnd;

    const amountToSkip = seekTo - currentTime;
    if (isTheUpcomingSilenceRangeStillPending && amountToSkip < 3) {
      // So that we don't skip continuously every few milliseconds.
      return;
      // You might ask: what's the point of skipping a range
      // that is still pending? Isn't it better to just wait until we know
      // where it ends and seek only once so as to not make it jarring
      // for the user?
      // The answer is buffering.
      // Many webistes only buffer media only a couple of seconds
      // ahead of current playback position. This especially applies to Twitch,
      // where pieces of silence could get bigger than the buffer duration.
      // So it might so happen that the original element is playing
      // a silent range, but the clone element has played to the end of the
      // buffered range and still hasn't found the end of this silence range,
      // but since the original element is playing a part that is far
      // from the end of the end of the buffered range, the website won't
      // bother fetching more data thinking that whatever is buffered now
      // is enough.
      //
      // In this case we want to advance the playback of the original element
      // such that it buffers more data such that the clone can
      // advance in analyzing it.
      // In addition, it perhaps makes it more obvious that the extension
      // didn't just stop skipping silence for no reason
      // and is actually working.
      // Also this gives the user an opportunity to see what is being skipped
      // by showing them certain parts of the part that is actually silent.
      //
      // TODO improvement: a better approach would be to seek once
      // if there is a lot to skip, and then simply increase the playback
      // rate of the original element by a lot.
      //
      // TODO improvement: would be nice to show on the chart that
      // despite the fact that we skipped only a part of a silent range,
      // we actially did notice that the entire range is silent.
      // So instead of showing `_lastSilenceSkippingSeek` on the chart,
      // show the actual silent ranges we get from `getNextSilenceRange()`.
      //
      // TODO improvement: the main point of skipping a pending silent range
      // is to make the website load (buffer) further chunks of the video,
      // but we currently do skip pending range even when
      // buffering is not a problem, e.g. for local videos where the clone
      // and the original element are buffered independently.
    }

    const seekInVideoTime = seekAt - currentTime;
    const seekInRealTime = seekInVideoTime / this.settings.soundedSpeed;
    // `maybeUpcomingSilenceRange` may be the same on two subsequent
    // 'timeupdate' handler calls, and each of them would unconditionally call this `setTimeout`.
    // This case is handled inside `this.maybeSeekOrSpeedup`.
    //
    // Just so the seek is performed a bit faster compared to `setTimeout`.
    // TODO perf: not very effective because `maybeSeekOrSpeedup` performs some checks that are
    // unnecessary when it is called immediately (and not by `setTimeout`).
    clearTimeout(this.maybeSeekOrSpeedupTimeoutId);
    // TODO improvement: should this be `<= expectedMinSetTimeoutDelay` instead of `<= 0`?
    if (seekInRealTime <= 0) {
      this.maybeSeekOrSpeedup(seekTo, seekAt);
    } else {
      // TODO fix: `clearTimeout` on `destroy`.
      this.maybeSeekOrSpeedupTimeoutId = (setTimeout as typeof window.setTimeout)(
        this.maybeSeekOrSpeedupBounded,
        seekInRealTime * 1000,
        seekTo,
        seekAt,
      );
    }
  }
  /**
   * Perform a seek to skip silence, or increase `playbackRate` if seeking is not good enough.
   * Or don't do either if neither actually saves time, or under some other circumstances.
   * This function is usually called with `setTimeout`, this is why it looks weird.
   * @param seekTo where to seek (currently it's always the end of a silent part).
   * @param seekScheduledTo what `el.currentTime` time we wanted this function to be called at.
   */
  maybeSeekOrSpeedup(seekTo: MediaTime, seekScheduledTo: MediaTime): void {
    const element = this.element;
    const { currentTime, paused } = element;

    // In cases where a seek is scheduled ahead of time, some event may happen that makes it better to not perform this
    // seek. For example, if the user decided to manually seek to some other time, or if I suck at coding and performed
    // a conflicting seek.
    // TODO perf: would be more efficient to `clearTimeout` instead. On what occasions though?
    const expectedCurrentTime = seekScheduledTo;
    const mustCancelSeek =
      Math.abs(currentTime - expectedCurrentTime) > 0.5 // E.g. if the user seeked manually to some other time
      || paused;
    if (mustCancelSeek) {
      return;
    }

    const seekAmount = seekTo - currentTime;
    // TODO improvement: just use `fastSeek`? Add a setting?
    const expectedSeekDuration = this.seekDurationProphet.nextSeekDurationMs / 1000;

    if (IS_DEV_MODE) {
      if (expectedSeekDuration < 0.010) {
        console.warn(
          '`expectedSeekDuration` got lower than 0.010, but we ignore silence ranges that are shorter than this.'
          + ' See `pushNewSilenceRange` in `ElementPlaybackControllerCloning/Lookahead.ts`'
        );
      }
    }

    const realTimeLeftUntilDestinationAtNormalSpeed = seekAmount / this.settings.soundedSpeed;
    // TODO should we maybe also calculate it before `setTimeout(maybeSeekOrSpeedup)`?
    // Also even if seeking was instant, when you perform one the new `currentTime` can be a bit lower (or bigger)
    // than the value that you assigned to it, so `seekTo !== currentTime` would not work.

    const canSaveTimeBySeeking: number =
      realTimeLeftUntilDestinationAtNormalSpeed - expectedSeekDuration;

    // TOOD but the `silenceSpeed` input is disabled. Maybe then we could use a constant value instead of
    // `this.settings.silenceSpeed`? Need to make sure to clamp it (`getAbsoluteClampedSilenceSpeed`).
    // If so, don't forget to change `_setSpeedAndLog` (because it accepts `SpeedName`).
    const playbackRateForSpeedup = this.settings.silenceSpeed;
    const realTimeLeftUntilDestinationAtSilenceSpeed = seekAmount / playbackRateForSpeedup;
    let canSaveTimeBySpeedingUp_: number =
      realTimeLeftUntilDestinationAtNormalSpeed -
      realTimeLeftUntilDestinationAtSilenceSpeed;
    if (browserHasAudioDesyncBug && this.settings.enableDesyncCorrection) {
      // Due to high `expectedSeekDuration` it may not be woth speeding up because each speedup increases desync.
      // TODO refactor: yes, one speedup actually takes 2 speed switches, so it should be 2 times
      // bigger, but `DO_DESYNC_CORRECTION_EVERY_N_SPEED_SWITCHES` is actually 2x bigger than
      // what its name suggests:
      // https://github.com/WofWca/jumpcutter/blob/68455a9e0f880cf6e904b64a490b3ea134b9a09e/src/entry-points/content/ElementPlaybackControllerCloning/ElementPlaybackControllerCloning.ts#L640-L642
      // So it's calculated correctly here.
      // This is what I call "not a bug, but a feature".
      const oneSpeedupDesyncCorrectionTimeCost =
        expectedSeekDuration / DO_DESYNC_CORRECTION_EVERY_N_SPEED_SWITCHES;
      canSaveTimeBySpeedingUp_ -= oneSpeedupDesyncCorrectionTimeCost;
    }
    const canSaveTimeBySpeedingUp = canSaveTimeBySpeedingUp_;

    const needForceSeekForDesyncCorrection = () => {
      if (browserHasAudioDesyncBug && this.settings.enableDesyncCorrection) {
        // Desync correction is crucial for ElementPlaybackControllerCloning because
        // otherwise we'll start skipping at incorrect time. Apparently it's audio that
        // gets out of sync with `el.currentTime`, not video.
        // TODO maybe then it even makes sense to ignore whether `enableDesyncCorrection === false`?
  
        // In order to save more time, we don't simply check if
        // `this._didNotDoDesyncCorrectionForNSpeedSwitches >= DO_DESYNC_CORRECTION_EVERY_N_SPEED_SWITCHES`.
        // It is better to perform desync correction when `realTimeLeftUntilDestinationWithoutSeeking`
        // is _barely_ below `expectedSeekDuration` even if `this._didNotDoDesyncCorrectionForNSpeedSwitches`
        // did not reach `DO_DESYNC_CORRECTION_EVERY_N_SPEED_SWITCHES` so we don't have to do it later, possibly when
        // `realTimeLeftUntilDestinationWithoutSeeking` is super small.
        // Yes, this means that we seek more often than `DO_DESYNC_CORRECTION_EVERY_N_SPEED_SWITCHES`, but I believe
        // that it's beneficial.
        // Perhaps there is a better way to describe this.
        //
        // In practice this number is between 0 and 1.
        const howMuchWeWantDesyncCorrection =
          this._didNotDoDesyncCorrectionForNSpeedSwitches / DO_DESYNC_CORRECTION_EVERY_N_SPEED_SWITCHES;
        // This is between 0 and Infinity (unless `realTimeLeftUntilDestinationAtNormalSpeed < 0`,
        // in which case it's between -Infinity and Infinity, but it's also ok, because we're just
        // gonna behave as if there was no this silent part).
        const howMuchWeWantToSeek =
          realTimeLeftUntilDestinationAtNormalSpeed / (expectedSeekDuration || Number.MIN_VALUE);
        const howMuchWeDontWantToSeek = 1 - howMuchWeWantToSeek;
        if (howMuchWeWantDesyncCorrection >= howMuchWeDontWantToSeek) {
          return true;
        }
      }
      return false;
    }

    const enum WhatToDo {
      NOTHING,
      SPEEDUP,
      SEEK,
    }
    const whatToDo: WhatToDo = (() => {
      // Why not just check it at the very start? Because it's somewhat expensive (well not
      // really, but I've challenged myself to write the code imagining that it is expensive)
      // and there are cases when we don't need to check `needForceSeekForDesyncCorrection()`
      // to decide what to do.
      const ifNeedForceSeekThenSeekElse = <T extends Exclude<WhatToDo, WhatToDo.SEEK>>(
        else_: T
      ): WhatToDo => {
        return needForceSeekForDesyncCorrection()
          ? WhatToDo.SEEK
          : else_;
      };
      // TODO improvement: maybe it's worth adding a multiplier of like 0.90 to one of the values
      // because e.g. we can tolerate saving 10% less time than we could have, but in return get
      // video not stopping for the duration of a seek. Maybe even turn it into a setting.
      if (canSaveTimeBySeeking > canSaveTimeBySpeedingUp) {
        if (canSaveTimeBySeeking <= 0) {
          return ifNeedForceSeekThenSeekElse(WhatToDo.NOTHING);
        }
        return WhatToDo.SEEK;
      }
      if (canSaveTimeBySpeedingUp <= 0) {
        return ifNeedForceSeekThenSeekElse(WhatToDo.NOTHING);
      }

      // `setTimeout` interval is not just the frame rate of the PC,
      // and it can be very short. 240 should be sane,
      // but let's not decrease it too much.
      // TODO determine this dynamically, as with `expectedSeekDuration`.
      const expectedMinimumSetTimeoutDelay = 1 / 240;
      // TODO but maybe otherwise we could simply use a smaller value of silenceSpeed instead of not speeding up
      // at all?
      // TODO improvement: or maybe it's wrong? Does knowing setTimeout period let us predict when
      // the next setTimeout is going to get called??
      // Wait, but maybe the `setTimeout` delay is not the only thing that should stop us from
      // changing `playbackRate`? Maybe it's just not worth for the user to try to speedup such a
      // short period because it won't save much time but make everything jumpy. It takes
      // on average 120 snippets shorter than 1 / 60 to save 0.875 of a second at silenceSpeed of 8.
      // Nah, sounds like an excuse to me.
      const speedupCanOvershoot = realTimeLeftUntilDestinationAtSilenceSpeed <= expectedMinimumSetTimeoutDelay;
      if (IS_DEV_MODE) {
        if (speedupCanOvershoot) {
          performance.mark('timeout-scheduled')
          setTimeout(() => {
            performance.mark('timeout-executed');
            const delay = performance.measure('timeout-delay', 'timeout-scheduled', 'timeout-executed').duration;
            if (delay < expectedMinimumSetTimeoutDelay * 1000) {
              console.warn('Did not speedup because expected `setTimeout` delay to be '
                + `> ${expectedMinimumSetTimeoutDelay * 1000}ms, but actually it was ${delay}ms`);
            }
          });
        }
      }
      if (speedupCanOvershoot) {
        if (canSaveTimeBySeeking > 0) {
          return WhatToDo.SEEK;
        }
        return ifNeedForceSeekThenSeekElse(WhatToDo.NOTHING);
      }

      return ifNeedForceSeekThenSeekElse(WhatToDo.SPEEDUP);
    })();

    if (whatToDo === WhatToDo.SEEK) {
      element.currentTime = seekTo;
      this._didNotDoDesyncCorrectionForNSpeedSwitches = 0;

      // It's very rough and I think it can skip the start of a sounded part. Also not supported in Chromium.
      // Also see the comment about seeking error above. TODO?
      // element.fastSeek(seekTo);

      // TODO it's wrong to pass only the `expectedSeekDuration` instead of the real one, but it's better
      // than passing 0.
      this.timeSavedTracker?.onSilenceSkippingSeek(seekTo - currentTime, expectedSeekDuration);

      this._lastSilenceSkippingSeek = [seekScheduledTo, seekTo];
    } else if (whatToDo === WhatToDo.SPEEDUP) {
      // TODO what if `realTimeLeftUntilDestinationAtSilenceSpeed` is pretty big? Need to cancel this if
      // the user seeks to a sounded place.
      // May be other caveats.

      this._setSpeedAndLog(SpeedName.SILENCE);
      setTimeout(
        () => this._setSpeedAndLog(SpeedName.SOUNDED),
        realTimeLeftUntilDestinationAtSilenceSpeed * 1000,
      );
      // Yes, there's actually two speed switches, but we increment it just once. Need to refactor.
      // Same in ElementPlaybackControllerStretching.
      this._didNotDoDesyncCorrectionForNSpeedSwitches++;
    }
  }
  maybeSeekOrSpeedupBounded = this.maybeSeekOrSpeedup.bind(this);

  /**
   * Assumes `init()` to has been or will be called (but not necessarily that its return promise has been resolved),
   * othersie it will never resolve its promise.
   * TODO refactor: make it work when it's false?
   */
  async destroy(): Promise<void> {
    // `await this._initPromise` because the `init` function has side-effects (e.g. doing
    // `elementMediaSource.disconnect()`) (which it should, because it's supposed to CONTROL the element),
    // so the outside scipt needs to make sure that two `init` methods from two different controllers
    // don't get executed at the same time for the same element (e.g. if we need to swtich from one controller
    // type to another).
    await this._initPromise; // TODO would actually be better to interrupt it if it's still going.
    assertDev(this.isInitialized());

    this._throttledInitLookahead.cancel();
    this.lookahead?.destroy();

    this._resolveDestroyedPromise();

    // TODO refactor: make sure built-in nodes (like gain) are also garbage-collected (I think they should be).
  }

  private _initLookahead() {
    const lookahead = this.lookahead = new Lookahead(
      this.element,
      this.settings,
      this.getMediaSourceCloneElement,
      () => this.clonePlaybackError = true,
    );
    // Destruction is performed in `this.destroy` directly.
    lookahead.ensureInit();
  }
  private _throttledInitLookahead = throttle(this._initLookahead, 1000);
  private destroyAndThrottledInitLookahead() {
    this.lookahead?.destroy();
    this.lookahead = undefined;
    this._throttledInitLookahead();
  }

  /**
   * Can be called either when initializing or when updating settings.
   * TODO It's more performant to only update the things that rely on settings that changed, in a reactive way, but for
   * now it's like this so its harder to forget to update something.
   * @param oldSettings - better to provide this so the current state can be reconstructed and
   * respected (e.g. if a silent part is currently playing it wont change speed to sounded speed as it would if the
   * parameter is omitted).
   * TODO refactor: maybe it's better to just store the state on the class instance?
   */
  private _setStateAccordingToNewSettings(newSettings: ControllerSettings, oldSettings: ControllerSettings | null) {
    this.settings = newSettings;
    assertDev(this.isInitialized());

    // https://html.spec.whatwg.org/multipage/media.html#loading-the-media-resource:dom-media-defaultplaybackrate
    // The most common case where `load` is called is when the current source is replaced with an ad (or
    // the opposite, when the ad ends).
    // It's also a good practice.
    // https://html.spec.whatwg.org/multipage/media.html#playing-the-media-resource:dom-media-defaultplaybackrate-2
    setDefaultPlaybackRateAndRememberIt(
      this.element,
      getActualPlaybackRateForSpeed(
        this.settings.soundedSpeed,
        this.settings.volumeThreshold
      )
    );

    // TODO do it as we do in ElementPlaybackControllerStretching, not always SOUNDED?
    // Fine for now though.
    this._setSpeedAndLog(SpeedName.SOUNDED);
    const lookaheadSettingsChanged =
      oldSettings && (
        newSettings.volumeThreshold !== oldSettings.volumeThreshold
        || newSettings.marginBefore !== oldSettings.marginBefore
        || newSettings.marginAfter !== oldSettings.marginAfter
        || newSettings.isOppositeDay !== oldSettings.isOppositeDay
      )
    if (lookaheadSettingsChanged) {
      // TODO inefficient. Better to add an `updateSettings` method to `Lookahead`.
      this.destroyAndThrottledInitLookahead();
    }
    // The previously scheduled `maybeSeekOrSpeedup` became scheduled to an incorrect time because
    // of this (so `Math.abs(currentTime - expectedCurrentTime)` inside `maybeSeekOrSpeedup`
    // will be big).
    if (newSettings.soundedSpeed !== oldSettings?.soundedSpeed) {
      clearTimeout(this.maybeSeekOrSpeedupTimeoutId);
      this.maybeScheduleMaybeSeekOrSpeedup();
    }
  }

  /**
   * May return a new unitialized instance of its class, if particular settings are changed. The old one gets destroyed
   * and must not be used. The new instance will get initialized automatically and may not start initializing
   * immediately (waiting for the old one to get destroyed).
   * Can be called before the instance has been initialized.
   */
  updateSettingsAndMaybeCreateNewInstance(newSettings: ControllerSettings): Controller {
    // TODO how about not updating settings that heven't been changed
    if (this.initialized) {
      const oldSettings = this.settings;
      this._setStateAccordingToNewSettings(newSettings, oldSettings);
    } else {
      this._pendingSettingsUpdates = newSettings;
    }

    return this;
  }

  private _setSpeedAndLog(speedName: SpeedName) {
    // Need to `maybeClosestNonNormalSpeed` because even in this algorithm we switch speeds. Not always though.
    const speedVal = getActualPlaybackRateForSpeed(
      speedName === SpeedName.SOUNDED
        ? this.settings.soundedSpeed
        : this.settings.silenceSpeed,
      this.settings.volumeThreshold
    );
    setPlaybackRateAndRememberIt(this.element, speedVal);
    const elementSpeedSwitchedAt = this.audioContext.currentTime;

    if (IS_DEV_MODE) {
      if (speedName === SpeedName.SOUNDED) {
        assertDev(
          this.element.playbackRate === this.element.defaultPlaybackRate,
          `Switched to soundedSpeed, but \`soundedSpeed !== defaultPlaybackRate\`:`
          + ` ${this.element.playbackRate} !== ${this.element.defaultPlaybackRate}`
          + 'Perhaps `defaultPlaybackRate` was updated outside of this extension'
          + ', or you forgot to update it yourself. It\'s not a major problem, just a heads-up'
        );
      }
    }

    const obj = this._lastActualPlaybackRateChange;
    assertDev(obj);
    // Avoiding creating new objects for performance.
    obj.time = elementSpeedSwitchedAt;
    obj.value = speedVal;
    obj.name = speedName;
    // return elementSpeedSwitchedAt;
  }

  get telemetry(): TelemetryRecord {
    assertDev(this.isInitialized());
    // TODO that's a lot of 0s, can we do something about it?
    return {
      clonePlaybackError: this.clonePlaybackError ? true : undefined,
      unixTime: Date.now() / 1000,
      intrinsicTime: this.element.currentTime,
      elementPlaybackActive: isPlaybackActive(this.element),
      contextTime: this.audioContext.currentTime,
      inputVolume: this.getVolume(),
      lastActualPlaybackRateChange: this._lastActualPlaybackRateChange,
      lastSilenceSkippingSeek: this._lastSilenceSkippingSeek,
      elementVolume: this.element.volume,
      totalOutputDelay: 0,
      delayFromInputToStretcherOutput: 0,
      stretcherDelay: 0,
      // TODO also log `interruptLastScheduledStretch` calls.
      // lastScheduledStretch: this._stretcherAndPitch.lastScheduledStretch,
      // lastScheduledStretchInputTime: undefined,
    };
  }
}
