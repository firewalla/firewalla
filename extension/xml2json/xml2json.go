/*    Copyright 2016 Firewalla LLC 
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

package main

import (
    "fmt"
    "os"
    "bufio"
    xj "github.com/melvinto/goxml2json"
)

func main() {
    xml := bufio.NewReader(os.Stdin)

    json, err := xj.Convert(xml)
    if err != nil {
        panic("That's embarrassing...")
    }

    fmt.Println(json.String())
}

