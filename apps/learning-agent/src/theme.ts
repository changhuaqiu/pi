import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";
import chalk from "chalk";

const selectListTheme: SelectListTheme = {
	selectedPrefix: chalk.cyan,
	selectedText: chalk.bold,
	description: chalk.dim,
	scrollInfo: chalk.dim,
	noMatch: chalk.dim,
};

export const editorTheme: EditorTheme = {
	borderColor: chalk.dim,
	selectList: selectListTheme,
};

export const markdownTheme: MarkdownTheme = {
	heading: chalk.bold.cyan,
	link: chalk.blue,
	linkUrl: chalk.dim,
	code: chalk.yellow,
	codeBlock: chalk.green,
	codeBlockBorder: chalk.dim,
	quote: chalk.italic,
	quoteBorder: chalk.dim,
	hr: chalk.dim,
	listBullet: chalk.cyan,
	bold: chalk.bold,
	italic: chalk.italic,
	strikethrough: chalk.strikethrough,
	underline: chalk.underline,
};
