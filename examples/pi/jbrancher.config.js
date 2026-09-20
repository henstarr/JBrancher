export default {
  // Keep the package's safe read-only built-ins and add project-specific routes.
  includeBuiltins: true,
  routes: [
    {
      id: 'test-status',
      match: ({ task }) => /^did the tests pass\??$/i.test(task.trim()),
      run: async ({ exec }) => {
        const result = await exec('npm', ['test']);
        return result.code === 0 ? 'Tests passed.' : (result.stderr || 'Tests failed.');
      }
    }
  ]
};
