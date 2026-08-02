// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

import "./ExpensesPage.css";
import { ExpenseCategories } from "../components/ExpenseCategories";
import { Expenses } from "../components/Expenses";

export function ExpensesPage() {
  return (
    <div className="page-content">
      <div className="section-stack">
        <ExpenseCategories />
        <Expenses />
      </div>
    </div>
  );
}
