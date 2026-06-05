import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('extension is present', () => {
		assert.ok(vscode.extensions.getExtension('linucs.vscode-arduino-cli'));
	});
});
