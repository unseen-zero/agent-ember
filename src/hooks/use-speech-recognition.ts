'use client'

import { useCallback, useRef, useState } from 'react'

interface SpeechRecognitionErrorEvent {
  error?: string
}

interface SpeechRecognitionEvent {
  results: { [index: number]: { [index: number]: { transcript: string } } }
}

interface UseSpeechRecognitionOptions {
  lang?: string
}

export function useSpeechRecognition(onResult: (text: string) => void, options?: UseSpeechRecognitionOptions) {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recogRef = useRef<{
    stop: () => void
    start: () => void
    continuous: boolean
    interimResults: boolean
    lang: string
    maxAlternatives?: number
    onresult?: (e: SpeechRecognitionEvent) => void
    onerror?: (e: SpeechRecognitionErrorEvent) => void
    onend?: () => void
  } | null>(null)

  const toggle = useCallback(() => {
    setError(null)
    if (recording) {
      recogRef.current?.stop()
      setRecording(false)
      return
    }

    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) {
      setError('Speech recognition is not supported in this browser.')
      return
    }

    const recog = new SR()
    recog.continuous = false
    recog.interimResults = false
    recog.maxAlternatives = 1
    recog.lang = options?.lang || (typeof navigator !== 'undefined' ? navigator.language : 'en-US')

    recog.onresult = (e: SpeechRecognitionEvent) => {
      setRecording(false)
      const transcript = e.results?.[0]?.[0]?.transcript?.trim() || ''
      if (transcript) onResult(transcript)
    }
    recog.onerror = (e: SpeechRecognitionErrorEvent) => {
      setRecording(false)
      const code = e?.error || 'unknown'
      const message = code === 'not-allowed'
        ? 'Microphone access denied. Allow mic permission and try again.'
        : code === 'no-speech'
          ? 'No speech detected. Try again.'
          : `Speech recognition error: ${code}`
      setError(message)
    }
    recog.onend = () => setRecording(false)

    recogRef.current = recog
    setRecording(true)
    try {
      recog.start()
    } catch {
      setRecording(false)
      setError('Could not start speech recognition.')
    }
  }, [recording, onResult, options?.lang])

  const supported = typeof window !== 'undefined' &&
    !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)

  return { recording, toggle, supported, error }
}
