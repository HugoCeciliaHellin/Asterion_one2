describe('Ground Segment Smoke Test', () => {
  test('test runner is functional', () => {
    expect(1 + 1).toBe(2);
  });

  test('environment is Node.js 20+', () => {
    const [major] = process.version.slice(1).split('.').map(Number);
    expect(major).toBeGreaterThanOrEqual(20);
  });
});
