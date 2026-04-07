import { describe, test, expect } from 'bun:test'
import { classify } from '../src/analysis'

describe('classify (L1 static map)', () => {
  test('Read tool → silent', () => {
    expect(classify('Read', { file_path: '/foo.ts' }, '/project')).toBe('silent')
  })
  test('Glob tool → silent', () => {
    expect(classify('Glob', {}, '/project')).toBe('silent')
  })
  test('Grep tool → silent', () => {
    expect(classify('Grep', {}, '/project')).toBe('silent')
  })
  test('LS tool → silent', () => {
    expect(classify('LS', {}, '/project')).toBe('silent')
  })
  test('TodoWrite tool → silent', () => {
    expect(classify('TodoWrite', {}, '/project')).toBe('silent')
  })
  test('WebFetch tool → silent', () => {
    expect(classify('WebFetch', {}, '/project')).toBe('silent')
  })
  test('WebSearch tool → silent', () => {
    expect(classify('WebSearch', {}, '/project')).toBe('silent')
  })
  test('NotebookRead tool → silent', () => {
    expect(classify('NotebookRead', {}, '/project')).toBe('silent')
  })
  test('Unknown tool defaults to review', () => {
    expect(classify('SomeNewTool', {}, '/project')).toBe('review')
  })
})
